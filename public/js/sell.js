// ============================================
// SaveHatke — Sell Coupon Logic
// ============================================

let selectedCategory = '';
let currentStep = 1;

document.addEventListener('DOMContentLoaded', () => {
  initCategorySelection();
});

function initCategorySelection() {
  document.querySelectorAll('.category-select-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!Auth.isLoggedIn()) {
        showToast('Please log in to sell coupons.', 'warning');
        openAuthModal('login');
        return;
      }

      // Highlight selected
      document.querySelectorAll('.category-select-btn').forEach((b) => {
        b.style.borderColor = '';
        b.style.boxShadow = '';
      });
      btn.style.borderColor = 'var(--color-blue-500)';
      btn.style.boxShadow = '0 0 15px rgba(37, 99, 235, 0.3)';

      selectedCategory = btn.dataset.cat;
      setTimeout(() => goToStep(2), 300);
    });
  });
}

function goToStep(step) {
  // Validate before advancing
  if (step === 3) {
    const code = document.getElementById('sellCode').value.trim();
    const brand = document.getElementById('sellBrand').value.trim();
    if (!code || !brand) {
      showToast('Please fill in the coupon code and brand.', 'warning');
      return;
    }
    updateReviewSummary();
  }

  currentStep = step;

  // Update stepper UI
  document.querySelectorAll('.stepper-step').forEach((s) => {
    const sStep = Number(s.dataset.step);
    s.classList.remove('active', 'completed');
    if (sStep === step) s.classList.add('active');
    if (sStep < step) s.classList.add('completed');
  });

  document.querySelectorAll('.stepper-line').forEach((line, i) => {
    line.classList.toggle('completed', i < step - 1);
  });

  // Show correct step content
  document.querySelectorAll('.step-content').forEach((c) => c.classList.remove('active'));
  const target = document.getElementById(`step-${step}`);
  if (target) target.classList.add('active');
}

function updateReviewSummary() {
  const summary = document.getElementById('reviewSummary');
  if (!summary) return;

  const code = document.getElementById('sellCode').value.trim().toUpperCase();
  const brand = document.getElementById('sellBrand').value.trim();
  const description = document.getElementById('sellDescription').value.trim();
  const value = document.getElementById('sellValue').value.trim();

  summary.innerHTML = `
    <table style="width: 100%; border-collapse: collapse;">
      <tr style="border-bottom: 1px solid var(--glass-border);">
        <td style="padding: 0.75rem; color: var(--color-slate-500); font-size: 0.875rem;">Category</td>
        <td style="padding: 0.75rem; color: var(--color-white); font-weight: 600;">${selectedCategory}</td>
      </tr>
      <tr style="border-bottom: 1px solid var(--glass-border);">
        <td style="padding: 0.75rem; color: var(--color-slate-500); font-size: 0.875rem;">Coupon Code</td>
        <td style="padding: 0.75rem;"><code style="background: rgba(37,99,235,0.1); padding: 3px 10px; border-radius: 4px; color: var(--color-teal-400); font-weight: 700; letter-spacing: 1px;">${code}</code></td>
      </tr>
      <tr style="border-bottom: 1px solid var(--glass-border);">
        <td style="padding: 0.75rem; color: var(--color-slate-500); font-size: 0.875rem;">Brand</td>
        <td style="padding: 0.75rem; color: var(--color-white); font-weight: 600;">${brand}</td>
      </tr>
      ${description ? `
        <tr style="border-bottom: 1px solid var(--glass-border);">
          <td style="padding: 0.75rem; color: var(--color-slate-500); font-size: 0.875rem;">Description</td>
          <td style="padding: 0.75rem; color: var(--color-slate-300);">${description}</td>
        </tr>
      ` : ''}
      ${value ? `
        <tr>
          <td style="padding: 0.75rem; color: var(--color-slate-500); font-size: 0.875rem;">Face Value</td>
          <td style="padding: 0.75rem; color: var(--color-white); font-weight: 600;">₹${value}</td>
        </tr>
      ` : ''}
    </table>
  `;
}

async function submitCoupon() {
  if (!Auth.isLoggedIn()) {
    showToast('Please log in to sell coupons.', 'warning');
    openAuthModal('login');
    return;
  }

  const btn = document.getElementById('submitSellBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    const data = await api('/coupons/sell', {
      method: 'POST',
      body: {
        code: document.getElementById('sellCode').value.trim(),
        category: selectedCategory,
        brand: document.getElementById('sellBrand').value.trim(),
        description: document.getElementById('sellDescription').value.trim(),
        originalValue: document.getElementById('sellValue').value.trim(),
      },
    });

    showToast(data.message, 'success', 6000);

    // Show success step
    document.querySelectorAll('.step-content').forEach((c) => c.classList.remove('active'));
    document.getElementById('step-success').classList.add('active');

    // Update stepper to all completed
    document.querySelectorAll('.stepper-step').forEach((s) => {
      s.classList.remove('active');
      s.classList.add('completed');
    });
    document.querySelectorAll('.stepper-line').forEach((l) => l.classList.add('completed'));
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = '✅ Submit & Earn ₹10';
  }
}

function resetForm() {
  selectedCategory = '';
  currentStep = 1;

  document.getElementById('sellCode').value = '';
  document.getElementById('sellBrand').value = '';
  document.getElementById('sellDescription').value = '';
  document.getElementById('sellValue').value = '';

  document.querySelectorAll('.category-select-btn').forEach((b) => {
    b.style.borderColor = '';
    b.style.boxShadow = '';
  });

  document.querySelectorAll('.stepper-step').forEach((s) => {
    s.classList.remove('active', 'completed');
  });
  document.querySelector('.stepper-step[data-step="1"]').classList.add('active');
  document.querySelectorAll('.stepper-line').forEach((l) => l.classList.remove('completed'));

  document.querySelectorAll('.step-content').forEach((c) => c.classList.remove('active'));
  document.getElementById('step-1').classList.add('active');

  const btn = document.getElementById('submitSellBtn');
  if (btn) {
    btn.disabled = false;
    btn.textContent = '✅ Submit & Earn ₹10';
  }
}
