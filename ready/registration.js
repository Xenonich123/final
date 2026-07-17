import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import exec from 'k6/execution';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

const CSV_PATH = __ENV.CSV_PATH || 'users.csv';
const csvText = open(CSV_PATH);

const users = new SharedArray('users', () => {
  const parsed = papaparse.parse(csvText, { header: true, skipEmptyLines: true });
  return parsed.data.filter((row) => row.username && String(row.username).trim());
});

if (users.length === 0) {
  throw new Error(`CSV ${CSV_PATH}: нет строк с username`);
}

export const options = {
  vus: 1,                    // параллельно 1 регистрация
  iterations: users.length,  // по одной итерации на каждую строку CSV
};

const BASE = 'http://194.87.238.215:8095';
const HOST = `${BASE}/WebTours/`;
const CGI = `${BASE}/cgi-bin`;

function extractUserSession(html) {
  const m = html.match(/name="userSession"\s+value="([^"]+)"/i);
  return m ? m[1] : null;
}

function rowForCurrentIteration() {
  const idx = exec.scenario.iterationInTest % users.length;
  const row = users[idx];
  return {
    username: String(row.username).trim(),
    password: String(row.password).trim(),
    firstName: String(row.firstName || '').trim(),
    lastName: String(row.lastName || '').trim(),
    address1: String(row.address1 || '').trim(),
    address2: String(row.address2 || '').trim(),
  };
}

export default function () {
  const user = rowForCurrentIteration();

  group('Open frameset', () => {
    const res = http.get(HOST, { redirects: 5 });
    check(res, { 'webtours status 200': (r) => r.status === 200 });
  });

  let userSession;

  group('nav.pl?in=home -> extract userSession', () => {
    const res = http.get(`${CGI}/nav.pl?in=home`, { redirects: 5 });
    check(res, { 'nav home status 200': (r) => r.status === 200 });

    userSession = extractUserSession(res.body);
    if (!userSession) {
      throw new Error('userSession not found');
    }
  });

  group('Open registration page', () => {
    const res = http.get(`${CGI}/login.pl?username=&password=&getInfo=true`, { redirects: 5 });
    check(res, { 'registration page status 200': (r) => r.status === 200 });
  });

  group('Register user (POST login.pl)', () => {
    const payload = {
      userSession: userSession,
      username: user.username,
      password: user.password,
      passwordConfirm: user.password,
      firstName: user.firstName,
      lastName: user.lastName,
      address1: user.address1,
      address2: user.address2,
      'register.x': '74',
      'register.y': '5',
    };

    const res = http.post(`${CGI}/login.pl`, payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirects: 5,
    });

    check(res, {
      'registration status 200': (r) => r.status === 200,
      'registration ok (not username taken)': (r) =>
        !/already exists|username taken|Web Tours Error/i.test(r.body),
      'Set-Cookie has MTUserInfo': (r) =>
        String(r.headers['Set-Cookie'] || '').includes('MTUserInfo='),
    });

    console.log(`REGISTERED USER: ${user.username} / ${user.password}`);
  });

  sleep(1);
}