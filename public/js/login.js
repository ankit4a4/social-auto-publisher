(function () {
  const loginForm = document.getElementById('loginForm');
  const loginAlert = document.getElementById('loginAlert');
  const submitBtn = document.getElementById('loginSubmit');
  const submitLabel = document.getElementById('loginSubmitLabel');
  const togglePassword = document.getElementById('togglePassword');
  const passwordInput = document.getElementById('loginPassword');

  function showAlert(message) {
    loginAlert.textContent = message;
    loginAlert.classList.remove('hidden');
  }

  function hideAlert() {
    loginAlert.classList.add('hidden');
  }

  function setLoading(isLoading) {
    submitBtn.disabled = isLoading;
    submitLabel.textContent = isLoading ? 'Signing in...' : 'Sign in';
    submitBtn.classList.toggle('is-loading', isLoading);
  }

  togglePassword.addEventListener('click', () => {
    const showing = passwordInput.type === 'text';
    passwordInput.type = showing ? 'password' : 'text';
    togglePassword.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    togglePassword.classList.toggle('is-active', !showing);
  });

  // If already logged in, skip straight to the dashboard.
  (async function checkExistingSession() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.ok) window.location.href = '/index.html';
    } catch (_err) {
      // Not logged in - stay on this page.
    }
  })();

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideAlert();
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          username: document.getElementById('loginUsername').value.trim(),
          password: passwordInput.value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Something went wrong');
      }
      window.location.href = '/index.html';
    } catch (err) {
      showAlert(err.message);
      setLoading(false);
    }
  });
})();
