'use client';

import { useEffect, useState } from 'react';

import { AuthError, requestOtp, verifyOtp, type AgentProfile } from '@/lib/auth-client';

import { computeSha256Hex, OfflineQueue } from './queue';

// Five-step flow:
//   request_otp -> verify_otp -> pu -> capture -> confirm -> done
//
// Auth is the real worker-backed flow: Twilio OTP (or NoOp in dev),
// JWT issuance, device fingerprint binding. The token + device hash are
// persisted by lib/auth-client.ts and travel on every authenticated
// request.

type Step = 'phone' | 'otp' | 'pu' | 'capture' | 'confirm' | 'done';

export function AgentFlow() {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpRequesting, setOtpRequesting] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);

  useEffect(() => {
    if (step !== 'capture') return;
    if (!('geolocation' in navigator)) return;
    const w = navigator.geolocation.watchPosition(
      (pos) =>
        setGps({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
        }),
      () => setGps(null),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 10_000 }
    );
    return () => navigator.geolocation.clearWatch(w);
  }, [step]);

  useEffect(() => {
    OfflineQueue.depth().then(setQueueDepth);
    const id = setInterval(() => OfflineQueue.depth().then(setQueueDepth), 5_000);
    return () => clearInterval(id);
  }, []);

  if (step === 'phone') {
    return (
      <Shell title="Sign in">
        <p className="text-slate-600">Enter the phone number registered with your party.</p>
        <input
          type="tel"
          inputMode="tel"
          placeholder="+234..."
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="mt-4 w-full border rounded px-4 py-3 text-lg"
        />
        {authError && (
          <p className="mt-3 text-sm text-red-700">
            {authError}
            {retryAfter ? ` Try again in ${retryAfter}s.` : ''}
          </p>
        )}
        <button
          disabled={otpRequesting || phone.trim().length < 4}
          onClick={async () => {
            setAuthError(null);
            setOtpRequesting(true);
            try {
              await requestOtp(phone);
              setStep('otp');
            } catch (e) {
              const err = e as AuthError;
              setAuthError(translateAuthError(err.code));
              setRetryAfter(
                (err.detail as { retry_after_seconds?: number })?.retry_after_seconds ?? null
              );
            } finally {
              setOtpRequesting(false);
            }
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {otpRequesting ? 'Sending code...' : 'Send code'}
        </button>
      </Shell>
    );
  }

  if (step === 'otp') {
    return (
      <Shell title="Enter the code">
        <p className="text-slate-600">
          We sent a 6-digit code to <span className="font-mono">{phone}</span>.
        </p>
        <input
          type="text"
          inputMode="numeric"
          placeholder="6-digit code"
          maxLength={6}
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
          className="mt-3 w-full border rounded px-4 py-3 text-lg tracking-widest text-center"
        />
        {authError && <p className="mt-3 text-sm text-red-700">{authError}</p>}
        <button
          disabled={otpVerifying || otp.length !== 6}
          onClick={async () => {
            setAuthError(null);
            setOtpVerifying(true);
            try {
              const { agent: profile } = await verifyOtp(phone, otp);
              setAgent(profile);
              setStep('pu');
            } catch (e) {
              const err = e as AuthError;
              setAuthError(translateAuthError(err.code));
            } finally {
              setOtpVerifying(false);
            }
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {otpVerifying ? 'Verifying...' : 'Verify and continue'}
        </button>
        <button
          onClick={() => {
            setOtp('');
            setAuthError(null);
            setStep('phone');
          }}
          className="mt-3 w-full text-slate-600 underline"
        >
          Use a different number
        </button>
      </Shell>
    );
  }

  if (step === 'pu' && agent) {
    return (
      <Shell title="Your polling unit">
        <dl className="space-y-2 text-sm">
          <Row label="Name" value={agent.full_name} />
          <Row label="Party" value={agent.party_code ?? '—'} />
          <Row label="PU code" value={agent.assigned_pu_code ?? '—'} mono />
        </dl>
        <button
          onClick={() => setStep('capture')}
          className="mt-6 w-full bg-ng-green text-white text-lg py-3 rounded font-medium"
        >
          Take photo of EC8A
        </button>
        <p className="mt-3 text-xs text-slate-500">
          You will only ever submit for this polling unit. If you need to change assignment,
          contact your party admin.
        </p>
      </Shell>
    );
  }

  if (step === 'capture' && agent) {
    return (
      <Shell title="Photograph the form">
        <div className="text-sm text-slate-600 mb-3">
          Photograph the whole EC8A. Make sure all four corners are visible and the signatures
          are legible.
        </div>
        <label className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-slate-50">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="text-sm">
            {file ? `Selected: ${file.name}` : 'Tap to open camera'}
          </div>
        </label>
        <div className="mt-3 text-xs text-slate-500">
          GPS: {gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)} (±${Math.round(gps.acc)}m)` : 'acquiring…'}
        </div>
        <button
          disabled={!file}
          onClick={() => setStep('confirm')}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          Continue
        </button>
      </Shell>
    );
  }

  if (step === 'confirm' && file && agent) {
    return (
      <Shell title="Confirm and submit">
        <img
          alt="EC8A preview"
          src={URL.createObjectURL(file)}
          className="w-full rounded border max-h-[60vh] object-contain"
        />
        <dl className="mt-3 space-y-1 text-sm">
          <Row label="PU code" value={agent.assigned_pu_code ?? '—'} mono />
          <Row label="GPS" value={gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : '—'} />
          <Row label="Captured at" value={new Date().toLocaleString()} />
        </dl>
        <button
          onClick={async () => {
            const buf = await file.arrayBuffer();
            const sha = await computeSha256Hex(buf);
            if (!agent.assigned_pu_code) {
              setAuthError('No polling unit assigned to your agent record.');
              return;
            }
            await OfflineQueue.enqueue({
              election_id: '2027-presidential',
              pu_code: agent.assigned_pu_code,
              source_type: 'party_agent',
              party_code: agent.party_code,
              image_blob: file,
              image_sha256: sha,
              image_bytes: file.size,
              gps,
              captured_at: new Date().toISOString(),
            });
            setStep('done');
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium"
        >
          Submit
        </button>
        <p className="mt-3 text-xs text-slate-500">
          If you are offline this will upload automatically when connectivity returns.
        </p>
      </Shell>
    );
  }

  if (step === 'done') {
    return (
      <Shell title="Submitted">
        <p className="text-sm">
          Your EC8A is queued. {queueDepth} submission{queueDepth === 1 ? '' : 's'} waiting to upload.
        </p>
        <button
          onClick={() => {
            setFile(null);
            setStep('pu');
          }}
          className="mt-5 w-full border py-3 rounded font-medium"
        >
          Done
        </button>
      </Shell>
    );
  }

  return null;
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto px-5 py-6">
      <h1 className="text-2xl font-bold mb-4">{title}</h1>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between border-b py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className={mono ? 'font-mono text-sm' : ''}>{value}</dd>
    </div>
  );
}

function translateAuthError(code: string): string {
  switch (code) {
    case 'phone_throttled':
      return 'Too many code requests for this number.';
    case 'ip_throttled':
      return 'Too many code requests from this network.';
    case 'no_active_otp':
      return 'No active code for this number. Request a new one.';
    case 'expired':
      return 'The code expired. Request a new one.';
    case 'code_mismatch':
      return 'That code does not match.';
    case 'too_many_attempts':
      return 'Too many incorrect attempts. Request a new code.';
    case 'already_consumed':
      return 'That code has already been used.';
    case 'phone_not_provisioned':
      return 'This number is not registered. Contact your party admin.';
    case 'device_change_required':
      return 'New device detected. Your admin must approve.';
    case 'invalid phone number':
    case 'unparseable phone':
      return 'That phone number is not valid.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
