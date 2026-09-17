/* eslint-disable no-console */
/**
 * Create the demo accounts: one rider, and one fully approved driver who can go
 * online straight away. Safe to run again — every step checks what already
 * exists first.
 *
 * Needs the API running (npm run dev) with OTP_PROVIDER=local and
 * LOCAL_DEV_MAGIC_OTP set — this is a development tool. The API refuses the
 * magic code in production, so this script cannot log in anywhere real.
 *
 *   npm run seed:demo                 # against http://127.0.0.1:4000
 *   API_URL=http://host:4000 npm run seed:demo
 *
 * Driver approval needs an ops account. The script grants the ops role to a
 * throwaway phone user for the approvals only and REMOVES it at the end, so no
 * phone-login admin is left behind.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import prismaPkg from '@prisma/client';

const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile) && !process.env.DATABASE_URL) process.loadEnvFile(envFile);

const { PrismaClient } = prismaPkg;
const API = process.env.API_URL ?? 'http://127.0.0.1:4000';
const CODE = process.env.LOCAL_DEV_MAGIC_OTP;

// 555-01xx is reserved for fiction in North America — these can never be a
// real person's phone.
const DEMO = {
  rider: { phone: '+14165550101', name: 'Demo Rider', email: 'demo.rider@uride.dev' },
  driver: { phone: '+14165550102', name: 'Demo Driver' },
  ops: { phone: '+14165550109' },
};

const VEHICLE = {
  make: 'Toyota',
  model: 'Corolla',
  year: 2022,
  color: 'White',
  plate: 'DEMO102',
  province: 'ON',
  rideClass: 'standard',
  seats: 4,
};

const REQUIRED_DOCS = [
  'drivers_license_front',
  'drivers_license_back',
  'vehicle_registration',
  'insurance',
  'profile_photo',
];
const EXPIRING = new Set(['drivers_license_front', 'drivers_license_back', 'vehicle_registration', 'insurance']);
const EXPIRES = '2030-12-31T00:00:00.000Z';

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function call(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function expectOk(r, what) {
  if (r.status >= 400) die(`${what} failed: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function login(phone) {
  expectOk(await call('/v1/auth/otp/request', { method: 'POST', body: { phone } }), `OTP request for ${phone}`);
  const data = expectOk(
    await call('/v1/auth/otp/verify', { method: 'POST', body: { phone, code: CODE } }),
    `OTP verify for ${phone}`,
  );
  return { token: (data.tokens ?? data).accessToken, id: data.user.id };
}

/** Smallest valid PNG — the storage layer checks magic bytes, so it must be real. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000154a24f5f0000000049454e44ae426082',
  'hex',
);

async function uploadDoc(token, type) {
  const form = new FormData();
  form.append('type', type);
  if (EXPIRING.has(type)) form.append('expiresAt', EXPIRES);
  form.append('file', new Blob([PNG], { type: 'image/png' }), `${type}.png`);
  const res = await fetch(`${API}/v1/drivers/me/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status >= 400) die(`upload ${type}: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------

if (!CODE) die('LOCAL_DEV_MAGIC_OTP is not set in backend/.env — the demo logins need it.');
const health = await fetch(`${API}/healthz`).catch(() => null);
if (!health || !health.ok) die(`API not reachable at ${API}. Start it first: npm run dev`);

const prisma = new PrismaClient();

try {
  // --- Rider ---------------------------------------------------------------
  console.log('\nRider');
  const rider = await login(DEMO.rider.phone);
  const riderMe = expectOk(await call('/v1/me', { token: rider.token }), 'rider profile');
  if (riderMe.fullName !== DEMO.rider.name || riderMe.email === null) {
    const r = await call('/v1/me', {
      method: 'PATCH',
      token: rider.token,
      body: { fullName: DEMO.rider.name, email: riderMe.email ?? DEMO.rider.email },
    });
    // Another account may already hold the demo email; the name still matters.
    if (r.status === 409) {
      expectOk(await call('/v1/me', { method: 'PATCH', token: rider.token, body: { fullName: DEMO.rider.name } }), 'rider name');
    } else expectOk(r, 'rider profile update');
  }
  const places = expectOk(await call('/v1/me/places', { token: rider.token }), 'rider places');
  if (!places.some((p) => p.kind === 'home')) {
    expectOk(
      await call('/v1/me/places', {
        method: 'POST',
        token: rider.token,
        body: { kind: 'home', name: 'Home', address: 'Union Station, 65 Front St W, Toronto, ON', location: { lat: 43.6453, lng: -79.3806 } },
      }),
      'rider home place',
    );
  }
  console.log('  ✓ ready');

  // --- Driver --------------------------------------------------------------
  console.log('Driver');
  let driver = await login(DEMO.driver.phone);
  expectOk(await call('/v1/me', { method: 'PATCH', token: driver.token, body: { fullName: DEMO.driver.name } }), 'driver name');

  let me = await call('/v1/drivers/me', { token: driver.token });
  if (me.status >= 400) {
    expectOk(
      await call('/v1/drivers/apply', {
        method: 'POST',
        token: driver.token,
        body: { licenceNumber: 'D1234-56789-00102', licenceProvince: 'ON', licenceExpiresAt: EXPIRES },
      }),
      'driver apply',
    );
    console.log('  ✓ applied');
    // The 'driver' role was granted by apply; this token predates it.
    driver = await login(DEMO.driver.phone);
    me = await call('/v1/drivers/me', { token: driver.token });
  }
  let profile = expectOk(me, 'driver profile');

  if (profile.profile.kycStatus !== 'approved') {
    if (!profile.vehicle) {
      let r = await call('/v1/drivers/me/vehicle', { method: 'POST', token: driver.token, body: VEHICLE });
      if (r.status === 409) {
        r = await call('/v1/drivers/me/vehicle', {
          method: 'POST',
          token: driver.token,
          body: { ...VEHICLE, plate: `DEMO${String(Date.now()).slice(-3)}` },
        });
      }
      expectOk(r, 'vehicle');
      console.log('  ✓ vehicle registered');
    }
    const uploaded = new Set(profile.documents.map((d) => d.type));
    for (const type of REQUIRED_DOCS) if (!uploaded.has(type)) await uploadDoc(driver.token, type);
    console.log('  ✓ documents uploaded');

    const sub = await call('/v1/drivers/me/submit', { method: 'POST', token: driver.token });
    if (sub.status >= 400 && sub.status !== 409) expectOk(sub, 'submit');
    console.log('  ✓ submitted for review');

    // --- Approve, as a temporary ops user ---------------------------------
    const ops = await login(DEMO.ops.phone);
    for (const role of ['admin', 'ops']) {
      await prisma.userRoleAssignment.upsert({
        where: { userId_role: { userId: ops.id, role } },
        create: { userId: ops.id, role },
        update: {},
      });
    }
    try {
      const opsToken = (await login(DEMO.ops.phone)).token;
      const detail = expectOk(await call(`/v1/admin/drivers/${driver.id}`, { token: opsToken }), 'admin driver detail');
      for (const doc of detail.documents) {
        if (doc.status !== 'approved') {
          expectOk(
            await call(`/v1/admin/drivers/${driver.id}/documents/${doc.id}/review`, { method: 'POST', token: opsToken, body: { decision: 'approve' } }),
            `approve ${doc.type}`,
          );
        }
      }
      if (detail.vehicle && detail.vehicle.status !== 'approved') {
        expectOk(
          await call(`/v1/admin/drivers/${driver.id}/vehicles/${detail.vehicle.id}/review`, { method: 'POST', token: opsToken, body: { decision: 'approve' } }),
          'approve vehicle',
        );
      }
      expectOk(await call(`/v1/admin/drivers/${driver.id}/approve`, { method: 'POST', token: opsToken, body: {} }), 'approve driver');
      console.log('  ✓ approved');
    } finally {
      // Never leave a phone-login account holding admin rights.
      await prisma.userRoleAssignment.deleteMany({ where: { userId: ops.id, role: { in: ['admin', 'ops'] } } });
    }
    profile = expectOk(await call('/v1/drivers/me', { token: driver.token }), 'driver profile');
  }

  if (profile.profile.kycStatus !== 'approved') die(`driver is ${profile.profile.kycStatus}, expected approved`);
  if (!profile.canGoOnline) die(`driver cannot go online: ${profile.blockers.join('; ')}`);
  console.log(`  ✓ ready — can go online (${profile.vehicle.make} ${profile.vehicle.model}, ${profile.vehicle.plate})`);

  console.log(`
Demo accounts
─────────────────────────────────────────────
Rider app   phone ${DEMO.rider.phone}   code ${CODE}
Driver app  phone ${DEMO.driver.phone}   code ${CODE}
─────────────────────────────────────────────
`);
} finally {
  await prisma.$disconnect();
}
