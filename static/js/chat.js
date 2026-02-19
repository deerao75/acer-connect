let socket = null;

let currentChatKey = null;    // e.g. "dm:<uid>" or "group:<id>"
let currentRoom = null;

const userListEl = document.getElementById("userList");
const groupListEl = document.getElementById("groupList");
const chatBodyEl = document.getElementById("chatBody");
const chatTitleEl = document.getElementById("chatTitle");
const chatSubtitleEl = document.getElementById("chatSubtitle");
const msgInputEl = document.getElementById("msgInput");
const chatTabsEl = document.getElementById("chatTabs");
const typingLineEl = document.getElementById("typingLine");

const minBtn = document.getElementById("minBtn");
const chatWrap = document.getElementById("chatWrap");
const miniBar = document.getElementById("miniBar");
const restoreBtn = document.getElementById("restoreBtn");
const miniLabel = document.getElementById("miniLabel");

const toastStack = document.getElementById("toastStack");
const logoutBtn = document.getElementById("logoutBtn");

const newGroupBtn = document.getElementById("newGroupBtn");
const groupModal = document.getElementById("groupModal");
const closeGroupModal = document.getElementById("closeGroupModal");
const createGroupBtn = document.getElementById("createGroupBtn");
const groupNameEl = document.getElementById("groupName");
const groupMembersEl = document.getElementById("groupMembers");
const groupErrEl = document.getElementById("groupErr");

const deleteChatBtn = document.getElementById("deleteChatBtn");

const groupInfoBtn = document.getElementById("groupInfoBtn");
const deleteGroupBtn = document.getElementById("deleteGroupBtn");

const groupInfoModal = document.getElementById("groupInfoModal");
const closeGroupInfo = document.getElementById("closeGroupInfo");
const groupInfoTitle = document.getElementById("groupInfoTitle");
const groupInfoList = document.getElementById("groupInfoList");

let USERS = [];
let GROUPS = [];

function emailToName(email){
  const local = (email || "").split("@")[0] || "";
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  const first = parts[0] ? parts[0][0].toUpperCase() + parts[0].slice(1) : "";
  const second = parts[1] ? parts[1][0].toUpperCase() + parts[1].slice(1) : "";
  return (first + " " + second).trim() || local;
}

function setLoggedInAs(){
  const el = document.getElementById("loggedInAs");
  if (!el) return;
  el.textContent = emailToName(window.ACERTAX_USER.email);
}

// -----------------------------
// Notifications (desktop popups)
// -----------------------------
async function ensureNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch {}
  }
}

function maybeDesktopNotify(title, body) {
  const should = document.hidden || !document.hasFocus();
  if (!should) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  try {
    const n = new Notification(title, { body });
    setTimeout(() => n.close(), 4000);
  } catch {}
}

// -----------------------------
// Typing indicator state
// -----------------------------
let typingTimer = null;
let lastTypingSent = 0;
const typingPeers = new Map(); // chatKey -> Set(uid)

// open chats map: key -> {type, label, room/group_id/other_uid, unread, messagesLoaded}
const OPEN = new Map();
// message cache: key -> array of messages
const CACHE = new Map();

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function toast(title, body) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<div class="toast-title">${escapeHtml(title)}</div><div class="toast-body">${escapeHtml(body)}</div>`;
  toastStack.appendChild(el);
  setTimeout(() => el.classList.add("show"), 10);
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 250);
  }, 3000);
}

function appendMessage(msg, isMine) {
  const row = document.createElement("div");
  row.className = `msg-row ${isMine ? "mine" : "theirs"}`;

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = `
    <div class="msg-text">${escapeHtml(msg.text)}</div>
    <div class="msg-meta">${new Date(msg.ts).toLocaleString()}</div>
  `;
  row.appendChild(bubble);
  chatBodyEl.appendChild(row);
  chatBodyEl.scrollTop = chatBodyEl.scrollHeight;
}

function renderFromCache(key) {
  chatBodyEl.innerHTML = "";
  const arr = CACHE.get(key) || [];
  for (const msg of arr) {
    appendMessage(msg, msg.from_uid === window.ACERTAX_USER.uid);
  }
}

function setChatTitle(title, subtitle="") {
  chatTitleEl.textContent = title;
  chatSubtitleEl.textContent = subtitle;
}

function minimizeChat() {
  chatWrap.classList.add("minimized");
  miniBar.classList.remove("hidden");
  miniLabel.textContent = currentChatKey ? `Minimized: ${chatTitleEl.textContent}` : "Chat minimized";
}
function restoreChat() {
  chatWrap.classList.remove("minimized");
  miniBar.classList.add("hidden");
}
minBtn.addEventListener("click", minimizeChat);
restoreBtn.addEventListener("click", restoreChat);

logoutBtn.addEventListener("click", async () => {
  await fetch("/logout", {method:"POST"});
  await firebase.auth().signOut();
  location.href = "/login";
});

function userDisplay(u) {
  return u.display_name || (u.email ? u.email.split("@")[0] : u.uid);
}

function dmKey(other_uid){ return `dm:${other_uid}`; }
function groupKey(group_id){ return `group:${group_id}`; }

// -----------------------------
// Unread persistence helpers
// -----------------------------
function threadIdForKey(key) {
  const info = OPEN.get(key);
  if (!info) return null;

  if (info.type === "dm") {
    const ids = [window.ACERTAX_USER.uid, info.other_uid].sort();
    return `dm_${ids[0]}_${ids[1]}`;
  }
  return `group_${info.group_id}`;
}

async function markReadForKey(key) {
  const tid = threadIdForKey(key);
  if (!tid) return;
  await fetch("/api/mark_read", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ thread_id: tid })
  });
}

async function loadUnread() {
  const res = await fetch("/api/unread");
  const j = await res.json();
  const items = j.items || [];

  for (const it of items) {
    const count = it.count || 0;
    if (count <= 0) continue;

    let key = null;
    if (it.type === "dm" && it.other_uid) key = dmKey(it.other_uid);
    if (it.type === "group" && it.group_id) key = groupKey(it.group_id);
    if (!key) continue;

    if (!OPEN.has(key)) {
      if (it.type === "dm") {
        const u = USERS.find(x => x.uid === it.other_uid);
        OPEN.set(key, {
          type: "dm",
          other_uid: it.other_uid,
          label: userDisplay(u || {display_name:"DM"}),
          unread: count,
          messagesLoaded: false
        });
      } else {
        const g = GROUPS.find(x => x.group_id === it.group_id);
        OPEN.set(key, {
          type: "group",
          group_id: it.group_id,
          label: g?.name || "Group",
          unread: count,
          messagesLoaded: false
        });
      }
    } else {
      const info = OPEN.get(key);
      info.unread = count;
      OPEN.set(key, info);
    }
  }

  renderTabs();
  renderUsers();
  renderGroups();
}

function markActiveLeft() {
  const active = currentChatKey;
  document.querySelectorAll("#userList .list-item").forEach(el => el.classList.remove("active"));
  document.querySelectorAll("#groupList .list-item").forEach(el => el.classList.remove("active"));

  if (!active) return;

  const activeEl = document.querySelector(`[data-key="${active}"]`);
  if (activeEl) activeEl.classList.add("active");
}

// -----------------------------
// Typing helpers
// -----------------------------
function updateTypingLine() {
  if (!typingLineEl) return;
  const key = currentChatKey;
  if (!key) { typingLineEl.textContent = ""; return; }

  const set = typingPeers.get(key);
  if (!set || set.size === 0) { typingLineEl.textContent = ""; return; }

  const uids = Array.from(set);
  const names = uids.slice(0, 2).map(uid => {
    const u = USERS.find(x => x.uid === uid);
    return u ? userDisplay(u) : "Someone";
  });

  typingLineEl.textContent =
    set.size === 1 ? `${names[0]} is typing…` :
    set.size === 2 ? `${names[0]} and ${names[1]} are typing…` :
    `${names[0]} and others are typing…`;
}

function setPeerTyping(chatKey, uid, isTyping) {
  let set = typingPeers.get(chatKey);
  if (!set) { set = new Set(); typingPeers.set(chatKey, set); }
  if (isTyping) set.add(uid);
  else set.delete(uid);
  updateTypingLine();
}

function keyRoomForCurrent() {
  const info = currentChatKey ? OPEN.get(currentChatKey) : null;
  if (!info) return null;

  if (info.type === "dm") {
    const ids = [window.ACERTAX_USER.uid, info.other_uid].sort();
    return { kind: "dm", room: `dm_${ids[0]}_${ids[1]}`, other_uid: info.other_uid };
  }
  return { kind: "group", room: `group_${info.group_id}`, group_id: info.group_id };
}

function clearTypingUIForChat(chatKey) {
  typingPeers.delete(chatKey);
  updateTypingLine();
}

function renderTabs() {
  chatTabsEl.innerHTML = "";
  for (const [key, info] of OPEN.entries()) {
    const tab = document.createElement("div");
    tab.className = `chat-tab ${key === currentChatKey ? "active" : ""}`;
    tab.title = info.label;
    tab.innerHTML = `
      <span>${escapeHtml(info.label)}</span>
      ${info.unread ? `<span class="badge">${info.unread}</span>` : ""}
      <span class="x">✕</span>
    `;

    tab.addEventListener("click", (e) => {
      if (e.target && e.target.classList.contains("x")) {
        OPEN.delete(key);
        CACHE.delete(key);
        clearTypingUIForChat(key);

        if (currentChatKey === key) {
          currentChatKey = null;
          currentRoom = null;
          setChatTitle("Select a chat", "");
          chatBodyEl.innerHTML = "";
          if (typingLineEl) typingLineEl.textContent = "";
          hide(groupInfoBtn);
          hide(deleteGroupBtn);
        }

        renderTabs();
        markActiveLeft();
        renderUsers();
        renderGroups();
        return;
      }
      switchToChat(key);
    });

    chatTabsEl.appendChild(tab);
  }
}

async function switchToChat(key) {
  // switch first, clear immediately to prevent overlap
  currentChatKey = key;
  currentRoom = null;
  chatBodyEl.innerHTML = "";

  // clear typing line for new chat (will be repopulated if events arrive)
  updateTypingLine();

  const info = OPEN.get(key);
  if (!info) return;

  // show whatever we already have instantly
  renderFromCache(key);

  info.unread = 0;
  OPEN.set(key, info);

  renderTabs();
  markActiveLeft();
  renderUsers();
  renderGroups();
  restoreChat();

  // ✅ Persist read state (unread should survive logout/login)
  markReadForKey(key).catch(() => {});

  if (info.type === "dm") {
    hide(groupInfoBtn);
    hide(deleteGroupBtn);

    const u = USERS.find(x => x.uid === info.other_uid);
    setChatTitle(userDisplay(u || {display_name: info.label}), (u?.online ? "Available" : "Not available"));
    await ensureSocket();
    socket.emit("join_dm", { other_uid: info.other_uid });

    const ids = [window.ACERTAX_USER.uid, info.other_uid].sort();
    currentRoom = `dm_${ids[0]}_${ids[1]}`;

    const cached = CACHE.get(key) || [];
    if (!info.messagesLoaded || cached.length === 0) {
      await loadHistoryDM(info.other_uid);
      info.messagesLoaded = true;
      OPEN.set(key, info);
    }
    renderFromCache(key);
    return;
  }

  if (info.type === "group") {
    show(groupInfoBtn);
    show(deleteGroupBtn);

    const g = GROUPS.find(x => x.group_id === info.group_id);
    setChatTitle(`# ${g?.name || info.label}`, `${g?.members?.length || 0} members`);
    await ensureSocket();
    socket.emit("join_group", { group_id: info.group_id });
    currentRoom = `group_${info.group_id}`;

    const cached = CACHE.get(key) || [];
    if (!info.messagesLoaded || cached.length === 0) {
      await loadHistoryGroup(info.group_id);
      info.messagesLoaded = true;
      OPEN.set(key, info);
    }
    renderFromCache(key);

    // Group info click -> load members and show modal
    groupInfoBtn.onclick = async () => {
      const res = await fetch(`/api/group/${info.group_id}`);
      const j = await res.json().catch(() => ({}));
      if (!j.ok) return;
      groupInfoTitle.textContent = `${j.group.name} — Members`;
      renderGroupMembers(j.group.members || []);
      show(groupInfoModal);
    };

    // Delete group click (creator/admin only)
    deleteGroupBtn.onclick = async () => {
      if (!confirm("Delete this group for everyone? This cannot be undone.")) return;
      const res = await fetch("/api/delete_group", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ group_id: info.group_id })
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(j.error || "Failed to delete group.");
        return;
      }

      // close this chat and refresh
      OPEN.delete(key);
      CACHE.delete(key);
      clearTypingUIForChat(key);

      if (currentChatKey === key) {
        currentChatKey = null;
        currentRoom = null;
        setChatTitle("Select a chat", "");
        chatBodyEl.innerHTML = "";
        if (typingLineEl) typingLineEl.textContent = "";
        hide(groupInfoBtn);
        hide(deleteGroupBtn);
      }

      renderTabs();
      await loadGroups();
      renderUsers();
      renderGroups();
      hide(groupInfoModal);
    };
  }
}

async function loadHistoryDM(other_uid) {
  const res = await fetch(`/api/history/dm/${other_uid}`);
  const j = await res.json();
  CACHE.set(dmKey(other_uid), j.messages || []);
}

async function loadHistoryGroup(group_id) {
  const res = await fetch(`/api/history/group/${group_id}`);
  const j = await res.json();
  CACHE.set(groupKey(group_id), j.messages || []);
}

async function ensureSocket() {
  const user = firebase.auth().currentUser;
  if (!user) throw new Error("Not signed in.");
  const token = await user.getIdToken();
  if (socket) return;

  socket = io({ transports: ["websocket"], query: { token } });

  socket.on("presence_update", (p) => {
    const u = USERS.find(x => x.uid === p.uid);
    if (u) {
      u.online = !!p.online;
      renderUsers(); // update dots
    }
  });

  // Typing updates
  socket.on("typing_update", (p) => {
    let key = null;

    if (p.type === "dm") {
      const my = window.ACERTAX_USER.uid;
      const other = (p.from_uid === my) ? null : p.from_uid;
      if (other) key = dmKey(other);
    } else if (p.type === "group") {
      key = groupKey(p.group_id);
    }

    if (!key) return;

    setPeerTyping(key, p.from_uid, !!p.is_typing);

    // safety auto-clear
    if (p.is_typing) {
      setTimeout(() => setPeerTyping(key, p.from_uid, false), 3500);
    }
  });

  socket.on("new_message", (msg) => {
    // Determine which chat key it belongs to
    let key = null;
    if (msg.type === "dm") {
      const my = window.ACERTAX_USER.uid;
      const other = (msg.from_uid === my) ? msg.to_uid : msg.from_uid;
      key = dmKey(other);
    } else if (msg.type === "group") {
      key = groupKey(msg.group_id);
    }
    if (!key) return;

    // cache it
    const arr = CACHE.get(key) || [];
    arr.push(msg);
    CACHE.set(key, arr);

    // if chat not open, open it in background (tabs)
    if (!OPEN.has(key)) {
      if (msg.type === "dm") {
        const u = USERS.find(x => x.uid === ((msg.from_uid === window.ACERTAX_USER.uid) ? msg.to_uid : msg.from_uid));
        OPEN.set(key, { type:"dm", other_uid: (u?.uid || ""), label: userDisplay(u || {display_name:"DM"}), unread:0, messagesLoaded:true });
      } else {
        const g = GROUPS.find(x => x.group_id === msg.group_id);
        OPEN.set(key, { type:"group", group_id: msg.group_id, label: g?.name || "Group", unread:0, messagesLoaded:true });
      }
      renderTabs();
      renderUsers();
      renderGroups();
    }

    const isMine = msg.from_uid === window.ACERTAX_USER.uid;
    const info = OPEN.get(key);

    // If active chat, render immediately
    if (key === currentChatKey) {
      appendMessage(msg, isMine);
      return;
    }

    // otherwise unread + toast + desktop notify
    if (!isMine) {
      info.unread = (info.unread || 0) + 1;
      OPEN.set(key, info);
      renderTabs();
      renderUsers();
      renderGroups();

      toast(info.label, msg.text);
      maybeDesktopNotify(info.label, msg.text);
    }
  });
}

async function loadUsers() {
  const res = await fetch("/api/users");
  const j = await res.json();
  USERS = j.users || [];
  renderUsers();
  renderGroupMemberChecklist();
}

async function loadGroups() {
  const res = await fetch("/api/groups");
  const j = await res.json();
  GROUPS = j.groups || [];
  renderGroups();
}

function renderUsers() {
  userListEl.innerHTML = "";
  USERS
    .filter(u => u.uid !== window.ACERTAX_USER.uid)
    .forEach(u => {
      const key = dmKey(u.uid);
      const item = document.createElement("div");
      item.className = "list-item";
      item.dataset.key = key;

      const unread = (OPEN.get(key)?.unread) || 0;

      item.innerHTML = `
        <div class="presence ${u.online ? "on" : "off"}"></div>
        <div class="li-main">
          <div class="li-title">${escapeHtml(userDisplay(u))}</div>
          <div class="li-sub muted">${escapeHtml(u.email || "")}</div>
        </div>
        ${unread ? `<div class="unread-badge">${unread}</div>` : ``}
      `;

      item.addEventListener("click", async () => {
        // open tab
        if (!OPEN.has(key)) {
          OPEN.set(key, { type:"dm", other_uid: u.uid, label: userDisplay(u), unread:0, messagesLoaded:false });
        }
        renderTabs();
        await switchToChat(key);
      });

      userListEl.appendChild(item);
    });

  markActiveLeft();
}

function renderGroups() {
  groupListEl.innerHTML = "";
  GROUPS.forEach(g => {
    const key = groupKey(g.group_id);
    const item = document.createElement("div");
    item.className = "list-item";
    item.dataset.key = key;

    const unread = (OPEN.get(key)?.unread) || 0;

    item.innerHTML = `
      <div class="group-badge">#</div>
      <div class="li-main">
        <div class="li-title">${escapeHtml(g.name)}</div>
        <div class="li-sub muted">${g.members.length} members</div>
      </div>
      ${unread ? `<div class="unread-badge">${unread}</div>` : ``}
    `;

    item.addEventListener("click", async () => {
      if (!OPEN.has(key)) {
        OPEN.set(key, { type:"group", group_id: g.group_id, label: g.name, unread:0, messagesLoaded:false });
      }
      renderTabs();
      await switchToChat(key);
    });

    groupListEl.appendChild(item);
  });

  markActiveLeft();
}

// Send
document.getElementById("sendBtn").addEventListener("click", async () => {
  const text = msgInputEl.value.trim();
  if (!text || !socket || !currentChatKey) return;

  msgInputEl.value = "";

  const info = OPEN.get(currentChatKey);
  if (!info) return;

  if (info.type === "dm") {
    socket.emit("send_dm", { to_uid: info.other_uid, text });
  } else {
    socket.emit("send_group", { group_id: info.group_id, text });
  }

  // stop typing on send
  const ctx = keyRoomForCurrent();
  if (ctx) {
    if (ctx.kind === "dm") socket.emit("typing_dm", { other_uid: ctx.other_uid, is_typing: false });
    else socket.emit("typing_group", { group_id: ctx.group_id, is_typing: false });
  }
});

msgInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("sendBtn").click();
});

// Typing emit
msgInputEl.addEventListener("input", async () => {
  if (!socket || !currentChatKey) return;

  const now = Date.now();
  if (now - lastTypingSent > 400) {
    lastTypingSent = now;
    const ctx = keyRoomForCurrent();
    if (!ctx) return;

    if (ctx.kind === "dm") socket.emit("typing_dm", { other_uid: ctx.other_uid, is_typing: true });
    else socket.emit("typing_group", { group_id: ctx.group_id, is_typing: true });
  }

  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    const ctx = keyRoomForCurrent();
    if (!ctx || !socket) return;
    if (ctx.kind === "dm") socket.emit("typing_dm", { other_uid: ctx.other_uid, is_typing: false });
    else socket.emit("typing_group", { group_id: ctx.group_id, is_typing: false });
  }, 900);
});

// Delete chat (soft-delete for me)
deleteChatBtn.addEventListener("click", async () => {
  if (!currentChatKey) return;
  const info = OPEN.get(currentChatKey);
  if (!info) return;

  const payload = info.type === "dm"
    ? { type:"dm", other_uid: info.other_uid }
    : { type:"group", group_id: info.group_id };

  const res = await fetch("/api/delete_chat", {
    method:"POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(payload)
  });

  if (!res.ok) return;

  // clear local UI/cache for this chat
  CACHE.set(currentChatKey, []);
  renderFromCache(currentChatKey);
});

// Group modal
newGroupBtn.addEventListener("click", () => {
  groupErrEl.textContent = "";
  groupNameEl.value = "";
  groupModal.classList.remove("hidden");
});

closeGroupModal.addEventListener("click", () => {
  groupModal.classList.add("hidden");
});

function renderGroupMemberChecklist() {
  groupMembersEl.innerHTML = "";
  USERS
    .filter(u => u.uid !== window.ACERTAX_USER.uid)
    .forEach(u => {
      const row = document.createElement("label");
      row.className = "checkrow";
      row.innerHTML = `
        <input type="checkbox" value="${u.uid}">
        <span>${escapeHtml(userDisplay(u))}</span>
        <span class="muted small">${escapeHtml(u.email || "")}</span>
      `;
      groupMembersEl.appendChild(row);
    });
}

createGroupBtn.addEventListener("click", async () => {
  groupErrEl.textContent = "";
  const name = groupNameEl.value.trim();
  const checked = Array.from(groupMembersEl.querySelectorAll("input[type=checkbox]:checked"))
    .map(x => x.value);

  if (!name) return (groupErrEl.textContent = "Group name required.");

  const res = await fetch("/api/create_group", {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ name, members: checked })
  });

  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    groupErrEl.textContent = j.error || "Failed to create group.";
    return;
  }

  groupModal.classList.add("hidden");
  await loadGroups();
});

function show(el){ if (el) el.classList.remove("hidden"); }
function hide(el){ if (el) el.classList.add("hidden"); }

function renderGroupMembers(members){
  groupInfoList.innerHTML = "";
  for (const m of members) {
    const row = document.createElement("div");
    row.className = "checkrow";
    row.innerHTML = `
      <div class="presence ${m.online ? "on" : "off"}"></div>
      <div style="display:flex;flex-direction:column;">
        <div style="font-weight:900;">${escapeHtml(m.display_name || m.email || m.uid)}</div>
        <div class="small muted">${escapeHtml(m.email || "")}</div>
      </div>
    `;
    groupInfoList.appendChild(row);
  }
}

// Group info modal close
if (closeGroupInfo) {
  closeGroupInfo.addEventListener("click", () => hide(groupInfoModal));
}

// Boot
async function boot() {
  setLoggedInAs();
  await ensureNotificationPermission();
  await loadUsers();
  await loadGroups();
  await loadUnread(); // ✅ load persisted unread counts
  await ensureSocket();
  updateTypingLine();
  hide(groupInfoBtn);
  hide(deleteGroupBtn);
}
boot();
