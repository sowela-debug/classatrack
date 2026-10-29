
const $ = (id) => document.getElementById(id);

let authMode = "login";
let currentUser = null;
let attendance = new Map();
let selectedDate = dateKey(new Date());
let visibleMonth = new Date(
  new Date().getFullYear(),
  new Date().getMonth(),
  1
);

function dateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function prettyDate(key, options = {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric"
}) {
  return dateFromKey(key).toLocaleDateString(undefined, options);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }

  return data;
}

let toastTimer;

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2600);
}

function setAuthMode(mode) {
  authMode = mode;

  $("login-tab").classList.toggle("active", mode === "login");
  $("register-tab").classList.toggle("active", mode === "register");

  $("auth-title").textContent = mode === "login"
    ? "Welcome back"
    : "Create your account";

  $("auth-subtitle").textContent = mode === "login"
    ? "Enter your details to continue."
    : "Start keeping track of your classes.";

  $("auth-submit").textContent = mode === "login"
    ? "Log in"
    : "Create account";

  $("password").autocomplete = mode === "login"
    ? "current-password"
    : "new-password";

  $("auth-error").textContent = "";
}

function showLoggedOut() {
  currentUser = null;
  $("auth-view").classList.remove("hidden");
  $("app-view").classList.add("hidden");
  $("user-area").classList.add("hidden");
}

async function showLoggedIn(user) {
  currentUser = user;

  $("auth-view").classList.add("hidden");
  $("app-view").classList.remove("hidden");
  $("user-area").classList.remove("hidden");

  $("user-label").textContent = user.username +
    (user.role === "admin" ? " · Admin" : "");

  $("admin-panel").classList.toggle(
    "hidden",
    user.role !== "admin"
  );

  await loadAttendance();

  if (user.role === "admin") {
    await loadUsers();
  }
}

async function loadAttendance() {
  const data = await api("/api/attendance");

  attendance = new Map(
    data.attendance.map(item => [item.date, item])
  );

  renderCalendar();
  renderSelectedDate();
}

function renderCalendar() {
  const year = visibleMonth.getFullYear();
  const month = visibleMonth.getMonth();

  $("month-title").textContent =
    visibleMonth.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric"
    });

  const grid = $("calendar-grid");
  grid.innerHTML = "";

  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = dateKey(new Date());

  for (let i = 0; i < 42; i++) {
    const dayNumber = i - firstWeekday + 1;
    const button = document.createElement("button");

    button.type = "button";

    if (dayNumber < 1 || dayNumber > daysInMonth) {
      button.className = "day outside";
      button.tabIndex = -1;
      button.setAttribute("aria-hidden", "true");
    } else {
      const key = dateKey(new Date(year, month, dayNumber));
      const record = attendance.get(key);

      button.className = "day";

      if (record) button.classList.add("attended");
      if (key === selectedDate) button.classList.add("selected");
      if (key === today) button.classList.add("today");

      button.setAttribute(
        "aria-label",
        prettyDate(key) + (record ? ", attended" : "")
      );

      button.setAttribute(
        "aria-pressed",
        key === selectedDate ? "true" : "false"
      );

      button.innerHTML = `
        <span class="day-number">${dayNumber}</span>
        <span class="day-dot"></span>
      `;

      button.addEventListener("click", () => {
        selectedDate = key;
        renderCalendar();
        renderSelectedDate();
      });
    }

    grid.appendChild(button);
  }

  const prefix =
    `${year}-${String(month + 1).padStart(2, "0")}-`;

  const count = [...attendance.keys()].filter(
    key => key.startsWith(prefix)
  ).length;

  $("month-count").textContent = count;
}

function renderSelectedDate() {
  $("selected-date-title").textContent = prettyDate(
    selectedDate,
    { month: "long", day: "numeric" }
  );

  $("selected-date-subtitle").textContent = prettyDate(
    selectedDate,
    { weekday: "long", year: "numeric" }
  );

  const record = attendance.get(selectedDate);

  $("attendance-form").classList.remove("hidden");
  $("empty-detail").classList.add("hidden");

  $("note").value = record ? record.note : "";
  $("char-count").textContent = $("note").value.length;

  $("remove-attendance").classList.toggle(
    "hidden",
    !record
  );

  $("app-message").textContent = record
    ? "Attendance recorded for this date."
    : "No attendance recorded yet.";
}

async function loadUsers() {
  try {
    const data = await api("/api/admin/users");
    const list = $("users-list");

    list.innerHTML = "";

    if (!data.users.length) {
      list.textContent = "No users yet.";
      return;
    }

    for (const user of data.users) {
      const row = document.createElement("div");
      row.className = "user-row";

      row.innerHTML = `
        <div class="avatar">
          ${escapeHtml(user.username.slice(0, 1).toUpperCase())}
        </div>
        <div class="user-info">
          <strong>${escapeHtml(user.username)}</strong>
          <small>
            ${user.attendance_count} attendance days ·
            joined ${escapeHtml(String(user.created_at).slice(0, 10))}
          </small>
        </div>
        <span class="role-pill">${escapeHtml(user.role)}</span>
        ${
          user.role === "admin"
            ? ""
            : `<button class="delete-user" type="button"
                data-user-id="${user.id}"
                data-username="${escapeHtml(user.username)}">
                Delete
              </button>`
        }
      `;

      list.appendChild(row);
    }

    list.querySelectorAll(".delete-user").forEach(button => {
      button.addEventListener("click", async () => {
        const username = button.dataset.username;

        if (!confirm(
          `Delete account "${username}" and all its attendance records?`
        )) return;

        try {
          await api(
            `/api/admin/users/${button.dataset.userId}`,
            { method: "DELETE" }
          );

          await loadUsers();
          showToast("User account deleted.");
        } catch (err) {
          showToast(err.message);
        }
      });
    });
  } catch (err) {
    showToast(err.message);
  }
}

// Switch between login and registration.
$("login-tab").addEventListener("click", () => {
  setAuthMode("login");
});

$("register-tab").addEventListener("click", () => {
  setAuthMode("register");
});

// Log in or create an account.
$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  $("auth-error").textContent = "";

  const username = $("username").value.trim();
  const password = $("password").value;

  const endpoint = authMode === "login"
    ? "/api/login"
    : "/api/register";

  $("auth-submit").disabled = true;

  try {
    const data = await api(endpoint, {
      method: "POST",
      body: JSON.stringify({ username, password })
    });

    $("auth-form").reset();
    await showLoggedIn(data.user);
  } catch (err) {
    $("auth-error").textContent = err.message;
  } finally {
    $("auth-submit").disabled = false;
    $("auth-submit").textContent = authMode === "login"
      ? "Log in"
      : "Create account";
  }
});

// Log out.
$("logout-btn").addEventListener("click", async () => {
  try {
    await api("/api/logout", {
      method: "POST",
      body: "{}"
    });
  } catch (err) {
    showToast(err.message);
    return;
  }

  attendance.clear();
  showLoggedOut();
  setAuthMode("login");
});

// Change the displayed month.
$("prev-month").addEventListener("click", () => {
  visibleMonth = new Date(
    visibleMonth.getFullYear(),
    visibleMonth.getMonth() - 1,
    1
  );

  renderCalendar();
});

$("next-month").addEventListener("click", () => {
  visibleMonth = new Date(
    visibleMonth.getFullYear(),
    visibleMonth.getMonth() + 1,
    1
  );

  renderCalendar();
});

// Return to today's date.
$("today-btn").addEventListener("click", () => {
  selectedDate = dateKey(new Date());

  visibleMonth = new Date(
    new Date().getFullYear(),
    new Date().getMonth(),
    1
  );

  renderCalendar();
  renderSelectedDate();
});

// Count note characters.
$("note").addEventListener("input", () => {
  $("char-count").textContent = $("note").value.length;
});

// Save attendance, or update the note for an existing date.
$("attendance-form").addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await api("/api/attendance", {
      method: "POST",
      body: JSON.stringify({
        date: selectedDate,
        note: $("note").value
      })
    });

    await loadAttendance();
    showToast("Attendance saved.");
  } catch (err) {
    showToast(err.message);
  }
});

// Remove an attendance record.
$("remove-attendance").addEventListener("click", async () => {
  if (!confirm(`Remove attendance for ${prettyDate(selectedDate)}?`)) {
    return;
  }

  try {
    await api(`/api/attendance/${selectedDate}`, {
      method: "DELETE"
    });

    await loadAttendance();
    showToast("Attendance removed.");
  } catch (err) {
    showToast(err.message);
  }
});

// Check whether the user already has an active login session.
(async function init() {
  try {
    const data = await api("/api/me");

    if (data.user) {
      await showLoggedIn(data.user);
    } else {
      showLoggedOut();
    }
  } catch (err) {
    showLoggedOut();
  }
})();
