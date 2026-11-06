'use strict';

(() => {
  const OWNER_EMAIL = 'rupayandas2024@gmail.com';
  const root = () => document.getElementById('personalFinanceRoot');
  const money = value => '₹' + Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const el = id => document.getElementById(id);
  const message = (text, error = false) => {
    const box = el('pfMessage');
    if (!box) return;
    box.textContent = text;
    box.style.display = text ? 'block' : 'none';
    box.style.color = error ? '#f87171' : '#00e272';
  };
  async function request(path, options = {}) {
    return api('/admin/personal-finance' + path, options);
  }
  window.loadPersonalFinance = async function loadPersonalFinance() {
    if (!root()) return;
    try {
      const data = await request('/overview');
      el('pfBalance').textContent = money(data.balance);
      el('pfAdditions').textContent = money(data.additions);
      el('pfExpenses').textContent = money(data.expenses);
      const body = el('pfTransactions');
      if (!data.transactions.length) {
        body.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:24px;color:#6b88aa">No expenses recorded yet.</td></tr>';
      } else {
        body.replaceChildren(...data.transactions.map(item => {
          const tr = document.createElement('tr');
          [item.transactionDate || '—', item.category || 'Other', item.note || '—', money(item.amount)].forEach(value => {
            const td = document.createElement('td'); td.textContent = value; tr.appendChild(td);
          });
          const td = document.createElement('td');
          td.textContent = 'Expense'; tr.appendChild(td);
          return tr;
        }));
      }
    } catch (err) {
      message(err.message || 'Could not load personal finance.', true);
    }
  };
  document.addEventListener('DOMContentLoaded', () => {
    const admin = typeof Auth !== 'undefined' ? Auth.getAdminUser() : null;
    const allowed = String(admin && admin.email || '').toLowerCase().trim() === OWNER_EMAIL;
    const nav = el('personalFinanceNav');
    if (nav) nav.style.display = allowed ? '' : 'none';
    if (!allowed) return;
    const addForm = el('pfAddBalanceForm');
    const expenseForm = el('pfExpenseForm');
    addForm && addForm.addEventListener('submit', async event => {
      event.preventDefault(); message('');
      const submit = addForm.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await request('/balance-add', { method: 'POST', body: { amount: el('pfAddAmount').value, note: el('pfAddNote').value } });
        addForm.reset(); message('Balance updated.'); await window.loadPersonalFinance();
      } catch (err) { message(err.message || 'Could not update balance.', true); }
      finally { submit.disabled = false; }
    });
    expenseForm && expenseForm.addEventListener('submit', async event => {
      event.preventDefault(); message('');
      const submit = expenseForm.querySelector('button[type="submit"]'); submit.disabled = true;
      try {
        await request('/expense', { method: 'POST', body: {
          amount: el('pfExpenseAmount').value, category: el('pfExpenseCategory').value,
          note: el('pfExpenseNote').value, transactionDate: el('pfExpenseDate').value
        }});
        expenseForm.reset(); el('pfExpenseDate').value = new Date().toISOString().slice(0, 10);
        message('Expense saved.'); await window.loadPersonalFinance();
      } catch (err) { message(err.message || 'Could not save expense.', true); }
      finally { submit.disabled = false; }
    });
    if (el('pfExpenseDate')) el('pfExpenseDate').value = new Date().toISOString().slice(0, 10);
  });
})();
