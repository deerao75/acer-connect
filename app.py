import os
import time
from datetime import datetime, timezone
from functools import wraps

import firebase_admin
from firebase_admin import credentials, auth, firestore
from flask import Flask, render_template, request, redirect, url_for, session, jsonify
from flask_socketio import SocketIO, emit, join_room, leave_room, disconnect
from firebase_admin import firestore as fs_admin
from google.cloud.firestore_v1.base_query import FieldFilter
from firebase_admin import firestore




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

def thread_id_dm(uid1, uid2):
    a, b = sorted([uid1, uid2])
    return f"dm_{a}_{b}"

def thread_id_group(group_id):
    return f"group_{group_id}"

def incr_unread(uid: str, thread_id: str, payload: dict):
    """
    payload can include: type, other_uid, group_id, label
    """
    ref = db.collection("users").document(uid).collection("unread").document(thread_id)
    ref.set({
        **payload,
        "count": firestore.Increment(1),
        "updated_ts": firestore.SERVER_TIMESTAMP,
    }, merge=True)

def clear_unread(uid: str, thread_id: str):
    ref = db.collection("users").document(uid).collection("unread").document(thread_id)
    ref.set({"count": 0, "updated_ts": firestore.SERVER_TIMESTAMP}, merge=True)

def _ts_sort_key(d: dict):
    """
    Sort key for messages where ts may be:
      - int/float (milliseconds)
      - ISO string
    """
    ts = d.get("ts")
    if isinstance(ts, (int, float)):
        return float(ts)
    if isinstance(ts, str):
        try:
            # handle "Z"
            s = ts.replace("Z", "+00:00")
            dt = datetime.fromisoformat(s)
            return dt.timestamp() * 1000.0
        except Exception:
            return 0.0
    return 0.0



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

from firebase_admin import auth

@app.get("/api/users")
@login_required
def api_users():
    """
    Return user list from Firebase Auth (all employees),
    merged with Firestore profile data (role, online, last_seen, display_name).
    """
    # 1) Pull Firestore profiles
    fs_profiles = {}
    for doc in db.collection("users").stream():
        fs_profiles[doc.id] = doc.to_dict() or {}

    # 2) Pull all Firebase Auth users (paginated)
    users_out = []
    page = auth.list_users()
    while page:
        for u in page.users:
            email = (u.email or "").lower()
            if not email.endswith("@acertax.com"):
                continue  # only company users

            prof = fs_profiles.get(u.uid, {})

            # If profile missing, create a basic one (so it appears immediately)
            if not prof:
                ensure_user_profile(u.uid, email)
                prof = db.collection("users").document(u.uid).get().to_dict() or {}

            users_out.append({
                "uid": u.uid,
                "email": email,
                "display_name": prof.get("display_name") or (email.split("@")[0]),
                "online": bool(prof.get("online", False)),
                "last_seen": prof.get("last_seen"),
                "role": prof.get("role", "employee"),
            })

        page = page.get_next_page()

    # sort online first, then name
    users_out.sort(key=lambda x: (not x["online"], (x["display_name"] or "").lower()))
    return jsonify({"ok": True, "users": users_out})


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
        "ts": int(time.time() * 1000),
        "deleted_for": [],

    }

    # Save to Firestore
    db.collection("messages").add(msg)

    # Persist unread for recipient (works even if they are offline/logged out)
    tid = thread_id_dm(u["uid"], to_uid)
    incr_unread(
        to_uid,
        tid,
        {"type": "dm", "other_uid": u["uid"]}
    )

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
        "ts": int(time.time() * 1000),
        "deleted_for": [],

    }

    db.collection("messages").add(msg)

    tid = thread_id_group(group_id)
    for m in members:
        if m == u["uid"]:
            continue
        incr_unread(
            m,
            tid,
            {"type": "group", "group_id": group_id}
        )

    emit("new_message", msg, room=room)

@app.get("/api/history/dm/<other_uid>")
@login_required
def api_history_dm(other_uid):
    uid = session["user"]["uid"]
    room = dm_room_id(uid, other_uid)

    msgs = []
    q = (db.collection("messages")
         .where(filter=FieldFilter("room", "==", room))
         .limit(200))

    for doc in q.stream():
        d = doc.to_dict() or {}
        deleted_for = d.get("deleted_for", [])
        if uid in deleted_for:
            continue
        d["id"] = doc.id
        msgs.append(d)

    msgs.sort(key=_ts_sort_key)
    return jsonify({"ok": True, "messages": msgs})


@app.get("/api/history/group/<group_id>")
@login_required
def api_history_group(group_id):
    uid = session["user"]["uid"]

    # membership check
    gdoc = db.collection("groups").document(group_id).get()
    if not gdoc.exists:
        return jsonify({"ok": False, "error": "Group not found"}), 404
    members = (gdoc.to_dict() or {}).get("members", [])
    if uid not in members:
        return jsonify({"ok": False, "error": "Not a member"}), 403

    msgs = []
    q = (db.collection("messages")
         .where(filter=FieldFilter("group_id", "==", group_id))
         .limit(200))

    for doc in q.stream():
        d = doc.to_dict() or {}
        deleted_for = d.get("deleted_for", [])
        if uid in deleted_for:
            continue
        d["id"] = doc.id
        msgs.append(d)

    msgs.sort(key=_ts_sort_key)
    return jsonify({"ok": True, "messages": msgs})

@app.post("/api/delete_chat")
@login_required
def api_delete_chat():
    data = request.get_json(force=True)
    chat_type = data.get("type")
    uid = session["user"]["uid"]

    if chat_type == "dm":
        other_uid = data.get("other_uid")
        room = dm_room_id(uid, other_uid)

        q = db.collection("messages").where(filter=FieldFilter("room", "==", room)).limit(500)
        batch = db.batch()
        count = 0
        for doc in q.stream():
            batch.update(doc.reference, {"deleted_for": fs_admin.ArrayUnion([uid])})
            count += 1
            if count % 400 == 0:
                batch.commit()
                batch = db.batch()
        if count % 400 != 0:
            batch.commit()

        return jsonify({"ok": True})

    if chat_type == "group":
        group_id = data.get("group_id")

        # membership check
        gdoc = db.collection("groups").document(group_id).get()
        if not gdoc.exists:
            return jsonify({"ok": False, "error": "Group not found"}), 404
        members = (gdoc.to_dict() or {}).get("members", [])
        if uid not in members:
            return jsonify({"ok": False, "error": "Not a member"}), 403

        q = db.collection("messages").where(filter=FieldFilter("group_id", "==", group_id)).limit(500)
        batch = db.batch()
        count = 0
        for doc in q.stream():
            batch.update(doc.reference, {"deleted_for": fs_admin.ArrayUnion([uid])})
            count += 1
            if count % 400 == 0:
                batch.commit()
                batch = db.batch()
        if count % 400 != 0:
            batch.commit()

        return jsonify({"ok": True})

    return jsonify({"ok": False, "error": "Invalid type"}), 400

@socketio.on("typing_dm")
def typing_dm(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()
    other_uid = data.get("other_uid")
    is_typing = bool(data.get("is_typing", False))
    room = dm_room_id(u["uid"], other_uid)
    # broadcast to the room, but not to the sender
    emit("typing_update", {
        "type": "dm",
        "room": room,
        "from_uid": u["uid"],
        "is_typing": is_typing
    }, room=room, include_self=False)


@socketio.on("typing_group")
def typing_group(data):
    u = request.environ.get("acertax_user")
    if not u:
        return disconnect()
    group_id = data.get("group_id")
    is_typing = bool(data.get("is_typing", False))

    # validate membership
    gdoc = db.collection("groups").document(group_id).get()
    if not gdoc.exists:
        return
    members = (gdoc.to_dict() or {}).get("members", [])
    if u["uid"] not in members:
        return

    room = f"group_{group_id}"
    emit("typing_update", {
        "type": "group",
        "room": room,
        "group_id": group_id,
        "from_uid": u["uid"],
        "is_typing": is_typing
    }, room=room, include_self=False)

@app.get("/api/unread")
@login_required
def api_unread():
    uid = session["user"]["uid"]
    out = []
    for doc in db.collection("users").document(uid).collection("unread").stream():
        d = doc.to_dict() or {}
        out.append({
            "thread_id": doc.id,
            "type": d.get("type"),
            "other_uid": d.get("other_uid"),
            "group_id": d.get("group_id"),
            "count": int(d.get("count") or 0),
        })
    return jsonify({"ok": True, "items": out})


@app.post("/api/mark_read")
@login_required
def api_mark_read():
    uid = session["user"]["uid"]
    data = request.get_json(force=True) or {}
    thread_id = data.get("thread_id")
    if not thread_id:
        return jsonify({"ok": False, "error": "thread_id required"}), 400

    clear_unread(uid, thread_id)
    return jsonify({"ok": True})


@app.get("/api/group/<group_id>")
@login_required
def api_group_detail(group_id):
    uid = session["user"]["uid"]

    gdoc = db.collection("groups").document(group_id).get()
    if not gdoc.exists:
        return jsonify({"ok": False, "error": "Group not found"}), 404

    d = gdoc.to_dict() or {}
    members = d.get("members", [])

    if uid not in members:
        return jsonify({"ok": False, "error": "Not a member"}), 403

    # Map member uids -> names/emails from Firestore users collection
    member_profiles = []
    for mid in members:
        udoc = db.collection("users").document(mid).get()
        ud = udoc.to_dict() or {}
        member_profiles.append({
            "uid": mid,
            "email": ud.get("email", ""),
            "display_name": ud.get("display_name") or (ud.get("email","").split("@")[0] if ud.get("email") else mid),
            "online": bool(ud.get("online", False)),
        })

    # sort online first then name
    member_profiles.sort(key=lambda x: (not x["online"], (x["display_name"] or "").lower()))

    return jsonify({
        "ok": True,
        "group": {
            "group_id": group_id,
            "name": d.get("name", "Unnamed Group"),
            "created_by": d.get("created_by"),
            "members": member_profiles
        }
    })

@app.post("/api/delete_group")
@login_required
def api_delete_group():
    uid = session["user"]["uid"]
    email = (session["user"].get("email") or "").lower()
    data = request.get_json(force=True) or {}
    group_id = data.get("group_id")

    if not group_id:
        return jsonify({"ok": False, "error": "group_id required"}), 400

    gref = db.collection("groups").document(group_id)
    gdoc = gref.get()
    if not gdoc.exists:
        return jsonify({"ok": False, "error": "Group not found"}), 404

    d = gdoc.to_dict() or {}
    members = d.get("members", [])

    if uid not in members:
        return jsonify({"ok": False, "error": "Not a member"}), 403

    is_creator = (d.get("created_by") == uid)
    is_admin = (email == "deepak.rao@acertax.com")

    if not (is_creator or is_admin):
        return jsonify({"ok": False, "error": "Only group creator/admin can delete"}), 403

    # delete group doc
    gref.delete()

    # optional: soft-clean unread counters for this group for all members
    tid = thread_id_group(group_id)
    for m in members:
        db.collection("users").document(m).collection("unread").document(tid).delete()

    return jsonify({"ok": True})


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5002, debug=True)
