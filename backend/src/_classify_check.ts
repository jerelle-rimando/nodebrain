import './agents/agentEngine';
import fs from 'fs';
import { approvalLevel, failureIsFatal } from './agents/agentEngine';
const dir = process.argv[2];
const login = fs.readFileSync(`${dir}/01-login.aria_full.txt`, 'utf8');
const add = fs.readFileSync(`${dir}/04-pim-add-employee.aria_full.txt`, 'utf8');
const list = fs.readFileSync(`${dir}/03-pim-employee-list.aria_full.txt`, 'utf8');
const ref = (s: string, re: RegExp) => s.split('\n').find(l => re.test(l))!.match(/\[ref=([^\]]+)\]/)![1];
const cases: Array<[string, string, any, string, string]> = [
  ['navigate', 'playwright__browser_navigate', { url: 'x' }, '', 'none'],
  ['type Username', 'playwright__browser_type', { target: ref(login, /textbox "Username"/), text: 'Admin' }, login, 'ask'],
  ['type + submit', 'playwright__browser_type', { target: ref(login, /textbox "Password"/), text: 'x', submit: true }, login, 'always'],
  ['press Enter', 'playwright__browser_press_key', { key: 'Enter' }, login, 'always'],
  ['press Tab', 'playwright__browser_press_key', { key: 'Tab' }, login, 'ask'],
  ['click Login button', 'playwright__browser_click', { target: ref(login, /button "Login"/) }, login, 'ask'],
  ['click PIM link', 'playwright__browser_click', { target: ref(add, /link "PIM"/) }, add, 'ask'],
  ['click Save', 'playwright__browser_click', { target: ref(add, /button "Save"/) }, add, 'always'],
  ['click Cancel', 'playwright__browser_click', { target: ref(add, /button "Cancel"/) }, add, 'ask'],
  ['click unlabelled icon button', 'playwright__browser_click', { target: ref(list, /\[ref=f2e296\]/) }, list, 'always'],
  ['click ref missing from snapshot', 'playwright__browser_click', { target: 'e99999' }, add, 'always'],
  ['click CSS selector', 'playwright__browser_click', { target: '#btn' }, add, 'always'],
  ['click, element text lies', 'playwright__browser_click', { target: ref(add, /button "Save"/), element: 'harmless dropdown' }, add, 'always'],
  ['fill_form', 'playwright__browser_fill_form', { fields: [] }, add, 'ask'],
  ['evaluate', 'playwright__browser_evaluate', { function: '() => 1' }, add, 'always'],
  ['future playwright tool', 'playwright__browser_new_thing', {}, add, 'ask'],
  ['slack post', 'slack__slack_post_message', {}, '', 'ask'],
  ['pdf read', 'pdf-reader__read_pdf', {}, '', 'ask'],
  ['take control', 'browser-handoff__ask_person_to_take_over', { reason: 'x' }, '', 'none'],
  ['custom server', 'myserver__do_thing', {}, '', 'ask'],
];
let bad = 0;
for (const [label, name, args, snap, want] of cases) {
  const got = approvalLevel(name, args, snap);
  if (got !== want) bad++;
  console.log(`${got === want ? 'ok ' : 'BAD'} approval  ${label}: ${got}${got === want ? '' : ` (want ${want})`}`);
}
const stale = 'Ref e96 not found in the current page snapshot. Try capturing new snapshot.';
const fatal: Array<[string, string, any, string, boolean]> = [
  ['stale ref on Save click', 'playwright__browser_click', 'always', stale, false],
  ['timeout on Save click', 'playwright__browser_click', 'always', 'TimeoutError: locator.click: Timeout 5000ms exceeded.', false],
  ['unknown error on Save click', 'playwright__browser_click', 'always', 'Target page, context or browser has been closed', true],
  ['unknown error on plain click', 'playwright__browser_click', 'ask', 'Target page, context or browser has been closed', false],
  ['read-only fill timeout', 'playwright__browser_type', 'ask', 'Timeout 5000ms exceeded', false],
  ['slack post failed', 'slack__slack_post_message', 'ask', 'anything', true],
  ['pdf read failed', 'pdf-reader__read_pdf', 'ask', 'ENOENT', false],
];
for (const [label, name, level, err, want] of fatal) {
  const got = failureIsFatal(name, level as any, err);
  if (got !== want) bad++;
  console.log(`${got === want ? 'ok ' : 'BAD'} fatal     ${label}: ${got}`);
}
console.log(bad ? `${bad} BAD` : 'all ok');
process.exit(bad ? 1 : 0);
