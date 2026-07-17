import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import papaparse from 'https://jslib.k6.io/papaparse/5.1.1/index.js';

// 60s — плавный набор до 20 VU; 30s — работа (бронь + отмена); 60s — снижение до 0 (выход из аккаунта в конце итерации).
export const options = {
  scenarios: {
    find_max: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: '1m', target: 15 },
        { duration: '2m', target: 25 },
        { duration: '2m', target: 35 },
        { duration: '2m', target: 45 },
        { duration: '2m', target: 50 },
        { duration: '2m', target: 60 },
        
      ],
      gracefulRampDown: '1m',
    },
  },
  thresholds: {
    http_req_failed: [{ threshold: 'rate<0.01', abortOnFail: true }],
    checks: [{ threshold: 'rate>0.99', abortOnFail: true }],
    http_req_duration: ['p(95)<5000'],
  },
};

const CSV_PATH = __ENV.CSV_PATH || 'users1.csv';
const csvText = open(CSV_PATH);

const users = new SharedArray('users', () => {
  const parsed = papaparse.parse(csvText, { header: true, skipEmptyLines: true });
  return parsed.data.filter((row) => row.username && String(row.username).trim());
});

if (users.length === 0) {
  throw new Error(`CSV ${CSV_PATH}: нет строк с username`);
}

const BASE = 'http://194.87.238.215:8095';
const HOST = `${BASE}/WebTours/`;
const CGI = `${BASE}/cgi-bin`;

const CREDIT_CARD = __ENV.CREDIT_CARD || 'user';
const EXP_DATE = __ENV.EXP_DATE || 'user';

function rowForCurrentIteration() {
  const idx = (__VU - 1) % users.length;
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

function extractUserSession(html) {
  let m = html.match(/name="userSession"\s+value="([^"]+)"/i);
  if (!m) {
    m = html.match(/value="([^"]+)"\s+name="userSession"/i);
  }
  return m ? m[1] : null;
}

function extractSelectOptions(html, selectName) {
  const options = [];
  const blockRe = new RegExp(`<select[^>]*name="${selectName}"[^>]*>([\\s\\S]*?)</select>`, 'i');
  const bm = html.match(blockRe);
  if (!bm) {
    return options;
  }
  const optRe = /<option[^>]*value="([^"]+)"/gi;
  let om;
  while ((om = optRe.exec(bm[1])) !== null) {
    if (om[1]) {
      options.push(om[1]);
    }
  }
  return options;
}

function extractInputValue(html, name) {
  const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function extractRadioValues(html, name) {
  const out = [];
  const re = new RegExp(`name="${name}"\\s+value="([^"]+)"`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function extractAllHiddenValues(html, name) {
  const out = [];
  const re = new RegExp(`name="${name.replace('.', '\\.')}"\\s+value="([^"]*)"`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function itineraryIsEmpty(html) {
  return /No flights have been reserved/i.test(html);
}

function pickRandom(arr) {
  if (!arr.length) {
    return null;
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickDistinctPair(departs, arrives) {
  let depart = pickRandom(departs);
  let arrive = pickRandom(arrives);
  let n = 0;
  while (depart && arrive && depart === arrive && n < 50) {
    arrive = pickRandom(arrives);
    n++;
  }
  return { depart, arrive };
}

/** Пауза 1–4 с между последовательными HTTP-запросами. */
function requestPause() {
  sleep(1 + Math.random() * 3);
}

/**
 * Снимает все бронирования: GET itinerary.pl, затем POST removeAllFlights
 * с hidden flightID и .cgifields из формы.
 */
function cancelAllBookedFlights() {
  const listRes = http.get(`${CGI}/itinerary.pl`, { redirects: 5 });
  if (listRes.status !== 200 || itineraryIsEmpty(listRes.body)) {
    return { listRes, cancelRes: null, hadBookings: false };
  }

  const flightIDs = extractAllHiddenValues(listRes.body, 'flightID');
  const cgiFields = extractAllHiddenValues(listRes.body, '.cgifields');
  if (!flightIDs.length) {
    return { listRes, cancelRes: null, hadBookings: true, parseError: true };
  }

  requestPause();

  const cancelRes = http.post(
    `${CGI}/itinerary.pl`,
    {
      'removeAllFlights.x': '40',
      'removeAllFlights.y': '12',
      flightID: flightIDs,
      '.cgifields': cgiFields,
    },
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      redirects: 5,
    },
  );

  return { listRes, cancelRes, hadBookings: true, parseError: false };
}

export default function () {
  let userSession;
  const u = rowForCurrentIteration();

  group('Open frameset', () => {
    const res = http.get(`${HOST}/`, { redirects: 5 });
    check(res, {
      'webtours is 200': (r) => r.status === 200,
    });
    requestPause();
  });

  group('Open home nav and extract userSession', () => {
    const res = http.get(`${CGI}/nav.pl?in=home`, { redirects: 5 });
    check(res, {
      'nav home is 200': (r) => r.status === 200,
    });
    userSession = extractUserSession(res.body);
    if (!userSession) {
      throw new Error('userSession not found in nav.pl?in=home');
    }
    requestPause();
  });

  group('Login page', () => {
    const res = http.get(`${CGI}/login.pl?username=&password=&getInfo=false`, { redirects: 5 });
    check(res, {
      'login page is 200': (r) => r.status === 200,
    });
    const us = extractUserSession(res.body);
    if (us) {
      userSession = us;
    }
    requestPause();
  });

  group('Submit login', () => {
    const res = http.post(
      `${CGI}/login.pl`,
      {
        userSession,
        username: u.username,
        password: u.password,
        'login.x': '40',
        'login.y': '12',
        JSFormSubmit: 'off',
      },
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirects: 5,
      },
    );
    check(res, {
      'login status is 200': (r) => r.status === 200,
      'login likely ok': (r) =>
        !/Invalid password|invalid password|Web Tours Error|could not log/i.test(r.body),
    });
    requestPause();
  });

  group('Flight search form', () => {
    const res = http.get(`${CGI}/reservations.pl?page=welcome`, { redirects: 5 });
    check(res, {
      'reservations welcome is 200': (r) => r.status === 200,
      'find flight form': (r) => r.body.includes('Find Flight') || r.body.includes('findFlights'),
    });
    requestPause();

    const departs = extractSelectOptions(res.body, 'depart');
    const arrives = extractSelectOptions(res.body, 'arrive');
    const departDate = extractInputValue(res.body, 'departDate') || '03/23/2026';
    const returnDate = extractInputValue(res.body, 'returnDate') || '03/24/2026';

    const { depart, arrive } = pickDistinctPair(departs, arrives);
    if (!depart || !arrive || depart === arrive) {
      throw new Error('Не удалось выбрать разные города вылета и прилёта');
    }

    const findRes = http.post(
      `${CGI}/reservations.pl`,
      {
        advanceDiscount: '0',
        depart,
        departDate,
        arrive,
        returnDate,
        numPassengers: '1',
        roundtrip: 'on',
        seatPref: 'None',
        seatType: 'Coach',
        'findFlights.x': '40',
        'findFlights.y': '12',
      },
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirects: 5,
      },
    );

    check(findRes, {
      'find flights 200': (r) => r.status === 200,
      'outbound radios present': (r) => r.body.includes('name="outboundFlight"'),
    });
    requestPause();

    const outboundFlights = extractRadioValues(findRes.body, 'outboundFlight');
    const returnFlights = extractRadioValues(findRes.body, 'returnFlight');
    const outboundFlight = pickRandom(outboundFlights);
    const returnFlight = pickRandom(returnFlights);

    if (!outboundFlight || !returnFlight) {
      console.log(findRes.body.slice(0, 4000));
      throw new Error('Список рейсов пуст — проверьте города и даты');
    }

    const reserveRes = http.post(
      `${CGI}/reservations.pl`,
      {
        outboundFlight,
        returnFlight,
        numPassengers: '1',
        advanceDiscount: '0',
        seatType: 'Coach',
        seatPref: 'None',
        'reserveFlights.x': '40',
        'reserveFlights.y': '12',
      },
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirects: 5,
      },
    );

    check(reserveRes, {
      'payment page': (r) => r.status === 200 && r.body.includes('Payment Details'),
    });
    requestPause();

    const pass1 = `${u.firstName} ${u.lastName}`.trim();

    const buyRes = http.post(
      `${CGI}/reservations.pl`,
      {
        firstName: u.firstName,
        lastName: u.lastName,
        address1: u.address1,
        address2: u.address2,
        pass1,
        creditCard: CREDIT_CARD,
        expDate: EXP_DATE,
        numPassengers: '1',
        seatType: 'Coach',
        seatPref: 'None',
        outboundFlight,
        advanceDiscount: '0',
        returnFlight,
        JSFormSubmit: 'off',
        'buyFlights.x': '40',
        'buyFlights.y': '12',
      },
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        redirects: 5,
      },
    );

    check(buyRes, {
      'reservation made': (r) => r.status === 200 && r.body.includes('Reservation Made'),
    });
    requestPause();
  });

  group('Itinerary (booked flights)', () => {
    const res = http.get(`${CGI}/itinerary.pl`, { redirects: 5 });
    check(res, {
      'itinerary is 200': (r) => r.status === 200,
      'itinerary has booking': (r) =>
        r.body.includes('Flight') ||
        r.body.includes('invoice') ||
        r.body.includes('Reservation') ||
        !r.body.includes('No flights'),
    });
    requestPause();
  });

  group('Flights nav bar', () => {
    const res = http.get(`${CGI}/nav.pl?page=menu&in=flights`, { redirects: 5 });
    check(res, {
      'flights nav is 200': (r) => r.status === 200,
      'flights menu loaded': (r) =>
        r.body.includes('Search Flights') ||
        r.body.includes('Flights Button') ||
        r.body.includes('Itinerary Button'),
    });
    requestPause();
  });

  group('Cancel all booked flights at end (itinerary.pl)', () => {
    const r = cancelAllBookedFlights();
    check(r.listRes, {
      'itinerary page is 200': (res) => res.status === 200,
    });

    if (!r.hadBookings) {
      check(r.listRes, {
        'no bookings to cancel': (res) => itineraryIsEmpty(res.body),
      });
    } else if (r.parseError) {
      check(r.listRes, {
        'itinerary had rows but no flightID hidden fields': () => false,
      });
    } else {
      check(r.cancelRes, {
        'cancel all status 200': (res) => res.status === 200,
        'all bookings removed': (res) =>
          itineraryIsEmpty(res.body) &&
          !/could not delete your entire itinerary/i.test(res.body),
      });
    }
  });
  requestPause();

  group('Sign off', () => {
    const res = http.get(`${CGI}/welcome.pl?signOff=1`, { redirects: 5 });
    check(res, {
      'sign off is 200': (r) => r.status === 200,
    });
  });
}
