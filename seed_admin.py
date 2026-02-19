import os
from datetime import datetime, timezone
from functools import wraps

import firebase_admin
from firebase_admin import credentials, auth, firestore
from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect

# -----------------------------
# Config
# -----------------------------
APP_NAME = "AcerTax Connect"
SERVICE_ACCOUNT_PATH = os.environ.get("FIREBASE_SERVICE_ACCOUNT", "firebase_service_account.json")
SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "change-this-in-prod")

# -----------------------------
# Init Flask + SocketIO
# -----------------------------
app = Flask(__name__)
app.secret_key = SECRET_KEY
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")

# -----------------------------
# Init Firebase Admin
# -----------------------------
if not firebase_admin._apps:
    cred = credentials.Certificate(SERVICE_ACCOUNT_PATH)
    firebase_admin.initialize_app(cred)

db = firestore.client()

# -----------------------------
# Helpers
# -----------------------------
def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped

def verify_firebase_id_token(id_token: str):
    try:
        decoded = auth.verify_id_token(id_token)
        return decoded  # contains uid, email, etc.
    except Exception:
        return None

def ensure_user_profile(uid: str, email: str):
    doc_ref = db.collection("users").document(uid)
    doc = doc_ref.get()
    if not doc.exists:
        doc_ref.set({
            "email": email.lower(),
            "role": "employee",
            "display_name": email.split("@")[0],
            "online": False,
            "last_seen": utc_now_iso(),
            "created_at": utc_now_iso(),
        }, merge=True)

def set_presence(uid: str, online: bool):
    db.collection("users").document(uid).set({
        "online": online,
        "last_seen": utc_now_iso(),
    }, merge=True)

def dm_room_id(uid1: str, uid2: str) -> str:
    a, b = sorted([uid1, uid2])
    return f"dm_{a}_{b}"

# -----------------------------
# Routes
# -----------------------------
@app.get("/")
def root():
    if session.get("user"):
        return redirect(url_for("chat"))
    return redirect(url_for("login"))

@app.get("/login")
def login():
    return render_template("login.html", app_name=APP_NAME)

@app.get("/chat")
@login_required
def chat():
    return render_template("chat.html", app_name=APP_NAME, user=session["user"])

@app.post("/session_login")
def session_login():
    """
    Frontend signs in with Firebase Auth and sends ID token here.
    We verify token server-side and establish Flask session.
    """
    data = request.get_json(force=True)
    id_token = data.get("idToken", "")
    decoded = verify_firebase_id_token(id_token)
    if not decoded:
        return jsonify({"ok": False, "error": "Invalid token"}), 401

    uid = decoded["uid"]
    email = decoded.get("email", "").lower()

    # Restrict to company domain
    if not email.endswith("@acertax.com"):
        return jsonify({"ok": False, "error": "Only @acertax.com emails allowed"}), 403

    ensure_user_profile(uid, email)

    # pull profile
    profile = db.collection("users").document(uid).get().to_dict() or {}
    session["user"] = {
        "uid": uid,
        "email": email,
        "role": profile.get("role", "employee"),
        "display_name": profile.get("display_name", email.split("@")[0]),
    }
    return jsonify({"ok": True})

@app.post("/logout")
def logout():
    session.clear()
    return jsonify({"ok": True})

@app.get("/api/users")
@login_required
def api_users():
    """
    Returns basic user list for left sidebar.
    """
    users = []
    for doc in db.collection("users").stream():
        d = doc.to_dict()
        users.append({
            "uid": doc.id,
            "email": d.get("email"),
            "display_name": d.get("display_name"),
            "online": bool(d.get("online", False)),
            "last_seen": d.get("last_seen"),
            "role": d.get("role", "employee"),
        })
    # sort online first, then name
    users.sort(key=lambda x: (not x["online"], x["display_name"] or ""))
    return jsonify({"ok": True, "users": users})

@app.get("/api/groups")
@login_required
def api_groups():
    """
    Returns groups where current user is a member.
    """
    uid = session["user"]["uid"]
    groups = []
    q = db.collection("groups").where("members", "array_contains", uid)
    for doc in q.stream():
        d = doc.to_dict()
        groups.append({
            "group_id": doc.id,
            "name": d.get("name", "Unnamed Group"),
            "members": d.get("members", []),
        })
    groups.sort(key=lambda g: g["name"])
    return jsonify({"ok": True, "groups": groups})

@app.post("/api/create_group")
@login_required
def api_create_group():
    """
    Create a group (admin or any employee - you can restrict if you want).
    """
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    member_uids = data.get("members") or []
    creator = session["user"]["uid"]

    if not name:
        return jsonify({"ok": False, "error": "Group name required"}), 400

    if creator not in member_uids:
        member_uids.append(creator)

    doc_ref = db.collection("groups").document()
    doc_ref.set({
        "name": name,
        "members": list(sorted(set(member_uids))),
        "created_by": creator,
        "created_at": utc_now_iso(),
    })
    return jsonify({"ok": True, "group_id": doc_ref.id})

# -----------------------------
# Socket.IO
# -----------------------------
@socketio.on("connect")
def on_connect():
    """
    Requires: client sends auth token in querystring: ?token=...
    """
    token = request.args.get("token", "")
    decoded = verify_firebase_id_token(token)
    if not decoded:
        return disconnect()

    uid = decoded["uid"]
    email = (decoded.get("email") or "").lower()
    if not email.endswith("@acertax.com"):
        return disconnect()

    ensure_user_profile(uid, email)
    set_presence(uid, True)

    # store on socket session
    session_user = {
        "uid": uid,
        "email": email,
    }
    # Using Flask session inside SocketIO is limited; store in request context:
    # We'll attach to the socket environ.
    request.environ["acertax_user"] = session_user

    emit("presence_update", {"uid": uid, "online": True}, broadcast=True)

@socketio.on("disconnect")
def on_disconnect():
    u = request.environ.get("acertax_user")
    if not u:
        return
    uid = u["uid"]
    set_presence(uid, False)
    emit("presence_update", {"uid": uid, "online": False}, broadcast=True)

@socketio.on("join_dm")
def join_dm(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()
    other_uid = data.get("other_uid")
    room = dm_room_id(u["uid"], other_uid)
    join_room(room)
    emit("joined_room", {"room": room})

@socketio.on("join_group")
def join_group(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()
    group_id = data.get("group_id")
    join_room(f"group_{group_id}")
    emit("joined_room", {"room": f"group_{group_id}"})

@socketio.on("send_dm")
def send_dm(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()

    to_uid = data.get("to_uid")
    text = (data.get("text") or "").strip()
    if not to_uid or not text:
        return

    room = dm_room_id(u["uid"], to_uid)

    msg = {
        "type": "dm",
        "room": room,
        "from_uid": u["uid"],
        "to_uid": to_uid,
        "text": text,
        "ts": utc_now_iso(),
    }

    # Save to Firestore
    db.collection("messages").add(msg)

    # Emit to room (both users)
    emit("new_message", msg, room=room)

@socketio.on("send_group")
def send_group(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()

    group_id = data.get("group_id")
    text = (data.get("text") or "").strip()
    if not group_id or not text:
        return

    # Validate membership (basic)
    gdoc = db.collection("groups").document(group_id).get()
    if not gdoc.exists:
        return
    members = (gdoc.to_dict() or {}).get("members", [])
    if u["uid"] not in members:
        return

    room = f"group_{group_id}"

    msg = {
        "type": "group",
        "group_id": group_id,
        "room": room,
        "from_uid": u["uid"],
        "text": text,
        "ts": utc_now_iso(),
    }

    db.collection("messages").add(msg)
    emit("new_message", msg, room=room)

if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
