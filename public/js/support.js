// ============================================
// SaveHatke — Support Page Logic
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // Pre-fill email if logged in
  if (Auth.isLoggedIn()) {
    const user = Auth.getUser();
    const nameField = document.getElementById('supportName');
    const emailField = document.getElementById('supportEmail');
    if (nameField && user?.name) nameField.value = user.name;
    if (emailField && user?.email) emailField.value = user.email;
  }

  initSupportForm();
});

function initSupportForm() {
  const form = document.getElementById('supportForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('supportSubmitBtn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
      const data = await api('/support/ticket', {
        method: 'POST',
        body: {
          name: document.getElementById('supportName').value.trim(),
          email: document.getElementById('supportEmail').value.trim(),
          subject: document.getElementById('supportSubject').value,
          message: document.getElementById('supportMessage').value.trim(),
        },
      });

      showToast(data.message, 'success', 6000);

      // Reset form
      form.reset();
      if (Auth.isLoggedIn()) {
        const user = Auth.getUser();
        document.getElementById('supportName').value = user?.name || '';
        document.getElementById('supportEmail').value = user?.email || '';
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '📨 Submit Ticket';
    }
  });
}

// ── FAQ Accordion ───────────────────────────────────────────────────────
function toggleAccordion(button) {
  const item = button.parentElement;
  const isActive = item.classList.contains('active');

  // Close all
  document.querySelectorAll('.accordion-item').forEach((i) => i.classList.remove('active'));

  // Open clicked if it wasn't active
  if (!isActive) {
    item.classList.add('active');
  }
}
