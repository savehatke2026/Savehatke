#!/usr/bin/env node
// ============================================
// SaveHatke — SOS Security Question Setup
// ============================================
// Configures the per-administrator security questions used by SOS backup
// access, and stores ONLY salted bcrypt hashes of the answers.
//
// Run it on a trusted machine:
//
//     node server/scripts/sos-setup-questions.js --admin rupayan
//     node server/scripts/sos-setup-questions.js --admin jaggik
//     node server/scripts/sos-setup-questions.js --admin rupayan --list
//     node server/scripts/sos-setup-questions.js --admin jaggik --question q3
//
// Why it is interactive: the answers are authentication secrets. They are typed
// here, hashed in memory, and discarded. They are never taken from a command
// line argument (shell history), never written to a file, never printed, and
// never sent anywhere. Terminal echo is off while you type.
//
// The question TEXT is fixed in code below so the two sets can never drift or
// be mixed up. Each administrator's set is completely independent.

const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const mongoose = require('mongoose');
const Admin = require('../models/Admin');
const { hashAnswer } = require('../utils/sosAnswers');

// ── The two question sets. Independent by construction. ───────────────────
const QUESTION_SETS = {
  rupayan: {
    match: 'rupayan',
    questions: [
      { key: 'father_name',      kind: 'text', question: "What is your father's name?" },
      { key: 'mother_name',      kind: 'text', question: "What is your mother's name?" },
      { key: 'dob',              kind: 'date', question: 'What is your date of birth?' },
      { key: 'school_name',      kind: 'text', question: 'What was the name of your school?' },
      { key: 'childhood_nick',   kind: 'text', question: 'What was your childhood nickname?' },
      { key: 'first_school',     kind: 'text', question: 'What was the name of your first school?' },
      { key: 'birth_city',       kind: 'text', question: 'In which city were you born?' },
      { key: 'fav_subject',      kind: 'text', question: 'What was your favourite subject in school?' },
    ],
  },
  jaggik: {
    match: 'jaggik',
    questions: [
      { key: 'father_name',   kind: 'text', question: "What is your father's name?" },
      { key: 'mother_name',   kind: 'text', question: "What is your mother's name?" },
      { key: 'dob',           kind: 'date', question: 'What is your date of birth?' },
      { key: 'first_school',  kind: 'text', question: 'What was the name of your first school?' },
      { key: 'birth_city',    kind: 'text', question: 'In which city were you born?' },
      { key: 'fav_subject',   kind: 'text', question: 'What was your favourite subject?' },
      { key: 'first_sport',   kind: 'text', question: 'What was the first sport you played?' },
    ],
  },
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] || '') : '';
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** Read one line with the terminal echo suppressed. */
function askHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      const s = String(char);
      if (s === '\n' || s === '\r' || s === '\u0004') process.stdin.removeListener('data', onData);
      else readline.moveCursor(process.stdout, -1000, 0), readline.clearLine(process.stdout, 1), process.stdout.write(prompt);
    };
    process.stdout.write(prompt);
    process.stdin.on('data', onData);
    rl.question('', (value) => {
      process.stdin.removeListener('data', onData);
      rl.close();
      process.stdout.write('\n');
      resolve(value);
    });
  });
}

function askVisible(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (v) => { rl.close(); resolve(v); }));
}

async function main() {
  const who = String(arg('admin') || '').toLowerCase().trim();
  const set = QUESTION_SETS[who];
  if (!set) {
    console.error(`Usage: node server/scripts/sos-setup-questions.js --admin <${Object.keys(QUESTION_SETS).join('|')}> [--list] [--question <key>]`);
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set. Add it to your .env before running this.');
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });

  // Match on the name, so the script never needs an email address typed in.
  const admin = await Admin.findOne({ name: new RegExp(`^${set.match}$`, 'i') }).select('+security_questions.answer_hash');
  if (!admin) {
    console.error(`No administrator named "${set.match}" exists in MongoDB. Seed the admins first.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const configured = new Map((admin.security_questions || []).map((q) => [q.key, q]));

  if (hasFlag('list')) {
    console.log(`\nSecurity questions for ${admin.name} (${admin.role}):\n`);
    set.questions.forEach((q, i) => {
      const existing = configured.get(q.key);
      const state = existing && existing.answer_hash ? 'configured' : 'NOT SET';
      const off = existing && existing.enabled === false ? ' [disabled]' : '';
      console.log(`  ${String(i + 1).padStart(2)}. [${q.key}] ${q.question}\n      ${state}${off}`);
    });
    console.log(`\n  Questions asked per SOS attempt: ${admin.sos_questions_required || 5}`);
    console.log(`  SOS enabled: ${admin.sos_enabled !== false} · available: ${admin.sos_available !== false}\n`);
    await mongoose.disconnect();
    return;
  }

  const only = String(arg('question') || '').trim();
  const todo = only ? set.questions.filter((q) => q.key === only) : set.questions;
  if (!todo.length) {
    console.error(`No question with key "${only}" in ${admin.name}'s set.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nConfiguring ${todo.length} security question(s) for ${admin.name}.`);
  console.log('Answers are hidden as you type, hashed immediately, and never stored or printed.');
  console.log('Press Enter on an empty line to leave a question unchanged.\n');
  console.log('Date answers accept 04-11-2010, 04/11/2010, 4-11-2010 or 2010-11-04.\n');

  const next = [];
  let changed = 0;

  for (const q of todo) {
    const existing = configured.get(q.key);
    const marker = existing && existing.answer_hash ? ' (already configured — Enter to keep)' : '';
    console.log(`— ${q.question}${marker}`);

    // Typed twice: a typo here locks the real administrator out of recovery.
    // eslint-disable-next-line no-await-in-loop
    const first = await askHidden('   Answer: ');
    if (!String(first).trim()) {
      if (existing) next.push(existing);
      console.log('   left unchanged\n');
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const again = await askHidden('   Confirm: ');
    if (String(first).trim() !== String(again).trim()) {
      console.log('   ✗ the two entries did not match — question left unchanged\n');
      if (existing) next.push(existing);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const answer_hash = await hashAnswer(first, q.kind);
    if (!answer_hash) {
      console.log(`   ✗ that is not a value this question accepts${q.kind === 'date' ? ' (expected a date)' : ''} — left unchanged\n`);
      if (existing) next.push(existing);
      continue;
    }

    next.push({ key: q.key, question: q.question, kind: q.kind, answer_hash, enabled: true, updated_at: new Date() });
    changed += 1;
    console.log('   ✓ stored as a salted hash\n');
  }

  // Anything not in this run keeps its existing configuration.
  const untouched = (admin.security_questions || []).filter(
    (q) => !next.some((n) => n.key === q.key) && !todo.some((t) => t.key === q.key)
  );
  admin.security_questions = [...untouched, ...next];

  if (!only) {
    const answer = await askVisible(`How many questions should each SOS attempt ask? [${admin.sos_questions_required || 5}] `);
    const n = parseInt(String(answer).trim(), 10);
    const answerable = admin.security_questions.filter((q) => q.answer_hash && q.enabled !== false).length;
    if (Number.isFinite(n) && n > 0) {
      admin.sos_questions_required = Math.min(n, Math.max(1, answerable));
    }
  }

  await admin.save();

  const answerable = admin.security_questions.filter((q) => q.answer_hash && q.enabled !== false).length;
  console.log(`\n✓ Saved. ${admin.name} now has ${answerable} answerable question(s); each SOS attempt asks ${admin.sos_questions_required}.`);
  if (answerable < admin.sos_questions_required) {
    console.log('⚠️  Fewer answerable questions than the per-attempt requirement — the attempt will ask all of them.');
  }
  if (changed) console.log(`   ${changed} answer hash(es) written this run.`);
  console.log('   Plaintext answers were not stored anywhere.\n');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Setup failed:', err.message);
  try { await mongoose.disconnect(); } catch (e) {}
  process.exit(1);
});
