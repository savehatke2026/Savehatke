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

// Screenshots only, 5MB each. These checks are a courtesy so the user hears
// about a bad file before a multi-MB upload starts; the server sniffs the actual
// bytes and enforces the same limits again, and its answer is the one that counts.
const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ATTACHMENT_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Read a File as base64 (without the data: prefix)
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(file) {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error('That screenshot is too large. The maximum size is 5MB.');
  }
  const type = (file.type || '').toLowerCase();
  if (!ATTACHMENT_ALLOWED_TYPES.includes(type)) {
    throw new Error('Please attach a PNG, JPG or WebP screenshot.');
  }
  const dataBase64 = await fileToBase64(file);
  const data = await api('/support/attachment', {
    method: 'POST',
    body: { filename: file.name, contentType: file.type, dataBase64 },
  });
  // { url: 'drive:<fileId>', fileId, name, mimeType, size, uploadedAt }
  return data;
}

function initSupportForm() {
  const form = document.getElementById('supportForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('supportSubmitBtn');
    btn.disabled = true;

    const fileInput = document.getElementById('supportAttachment');
    const file = fileInput && fileInput.files ? fileInput.files[0] : null;
    let attachment = null;

    try {
      // Upload the attachment first (if any); ticket still submits without it on failure
      if (file) {
        btn.textContent = 'Uploading attachment…';
        try {
          attachment = await uploadAttachment(file);
        } catch (err) {
          showToast(err.message + ' — submitting ticket without attachment.', 'warning', 6000);
        }
      }

      // Validate Turnstile CAPTCHA
      const turnstileToken = typeof turnstile !== 'undefined' ? turnstile.getResponse() : '';
      if (!turnstileToken) {
        showToast('Please complete the security check before submitting.', 'error');
        btn.disabled = false;
        btn.textContent = '📨 Submit Ticket';
        return;
      }

      btn.textContent = 'Submitting...';
      const data = await api('/support/ticket', {
        method: 'POST',
        body: {
          name: document.getElementById('supportName').value.trim(),
          email: document.getElementById('supportEmail').value.trim(),
          subject: document.getElementById('supportSubject').value,
          message: document.getElementById('supportMessage').value.trim(),
          attachmentUrl: attachment ? attachment.url : '',
          attachmentName: attachment ? attachment.name : '',
          attachmentMime: attachment ? attachment.mimeType : '',
          attachmentSize: attachment ? attachment.size : '',
          cfTurnstileToken: turnstileToken,
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
      
      // Reset Turnstile widget
      if (typeof turnstile !== 'undefined') {
        turnstile.reset();
      }
    } catch (err) {
      showToast(err.message, 'error');
      
      // Reset Turnstile widget on error too
      if (typeof turnstile !== 'undefined') {
        turnstile.reset();
      }
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
