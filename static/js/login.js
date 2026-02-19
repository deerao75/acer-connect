const errEl = document.getElementById("err");
const btn = document.getElementById("loginBtn");

function showErr(msg) {
  errEl.textContent = msg || "";
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

    // establish server session
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

    location.href = "/chat";
  } catch (e) {
    showErr(e.message || "Login failed.");
  }
});
