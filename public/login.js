const form = document.querySelector('#login-form');
const error = document.querySelector('#login-error');
const params = new URLSearchParams(location.search);
const next = params.get('next') || '/';

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  error.hidden = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.username.value,
        password: form.password.value,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      error.textContent = data.error || 'Sign in failed';
      error.hidden = false;
      button.disabled = false;
      return;
    }
    const dest = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/';
    location.assign(dest);
  } catch {
    error.textContent = 'Can’t reach berrytone';
    error.hidden = false;
    button.disabled = false;
  }
});
