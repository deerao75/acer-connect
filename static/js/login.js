const errEl = document.getElementById("err");
const btn = document.getElementById("loginBtn");

function showErr(msg) {
  errEl.textContent = msg || "";
}

function showChangePasswordForm() {
  document.querySelector(".form").innerHTML = `
    <p style="color:#666;margin-bottom:12px;">Welcome! Please set a new password to continue.</p>
    <label>New Password</label>
    <input id="newPassword" type="password" placeholder="Min 6 characters" />
    <label>Confirm Password</label>
    <input id="confirmPassword" type="password" placeholder="Repeat password" />
    <button id="changeBtn" class="btn-primary">Set Password</button>
    <div id="err" class="error"></div>
  `;
  document.getElementById("changeBtn").addEventListener("click", async () => {
    const errEl2 = document.getElementById("err");
    const np = document.getElementById("newPassword").value;
    const cp = document.getElementById("confirmPassword").value;
    if (np.length < 6) return errEl2.textContent = "Password must be at least 6 characters.";
    if (np !== cp) return errEl2.textContent = "Passwords do not match.";

    const res = await fetch("/api/change_password", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ password: np })
    });
    const j = await res.json();
    if (!j.ok) return errEl2.textContent = j.error || "Failed to change password.";
    location.href = "/chat";
  });
}

btn.addEventListener("click", async () => {
  showErr("");
  const email = document.getElementById("email").value.trim().toLowerCase();
  const password = document.getElementById("password").value;

  if (!email.endsWith("@acertax.com")) {
    return showErr("Only @acertax.com email IDs can login.");
  }
  if (!password) return showErr("Password required.");

  try {
    const cred = await firebase.auth().signInWithEmailAndPassword(email, password);
    const token = await cred.user.getIdToken();

    const res = await fetch("/session_login", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ idToken: token })
    });

    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      await firebase.auth().signOut();
      return showErr(j.error || "Login blocked.");
    }

    const j = await res.json();
    if (j.first_login) {
      showChangePasswordForm();
    } else {
      location.href = "/chat";
    }
  } catch (e) {
    showErr(e.message || "Login failed.");
  }
});
