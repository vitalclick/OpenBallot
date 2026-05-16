'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { AuthError, logout, requestOtp, verifyOtp, type AgentProfile } from '@/lib/auth-client';
import { pollSubmission, type SubmissionStatus } from '@/lib/uploads';

import { computeSha256Hex, OfflineQueue, requestBackgroundSync, type DrainMessage } from './queue';
import { QueuePanel } from './QueuePanel';

// Five-step flow:
//   request_otp -> verify_otp -> pu -> capture -> confirm -> done
//
// Auth is the real worker-backed flow: Twilio OTP (or NoOp in dev),
// JWT issuance, device fingerprint binding. The token + device hash are
// persisted by lib/auth-client.ts and travel on every authenticated
// request.

type Step = 'phone' | 'otp' | 'pu' | 'capture' | 'confirm' | 'done';

interface ElectionOption {
  id: string;
  election_type: string;
  status: string;
  election_date?: string;
}

export function AgentFlow() {
  const t = useTranslations('agent');

  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [otpRequesting, setOtpRequesting] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [agent, setAgent] = useState<AgentProfile | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [queueDepth, setQueueDepth] = useState(0);
  const [elections, setElections] = useState<ElectionOption[] | null>(null);
  const [electionId, setElectionId] = useState<string | null>(null);

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

  // Fetch the election list once the agent is signed in so the PU screen
  // can default (single election) or offer a picker (multiple).
  useEffect(() => {
    if (!agent) return;
    let cancelled = false;
    fetch('/api/v1/elections')
      .then((r) => r.json())
      .then((rows: ElectionOption[]) => {
        if (cancelled) return;
        const active = (Array.isArray(rows) ? rows : []).filter(
          (e) => e.status !== 'concluded'
        );
        setElections(active);
        if (active.length === 1) setElectionId(active[0].id);
      })
      .catch(() => {
        if (cancelled) return;
        setElections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  // Drainer: every 5 seconds, attempt to upload any queued submissions.
  // In production a service worker takes over when the page is hidden;
  // this in-page drainer covers the foreground case.
  const [drainNote, setDrainNote] = useState<string | null>(null);
  const [lastAcceptedId, setLastAcceptedId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        await OfflineQueue.drainOnce((msg: DrainMessage) => {
          if (cancelled) return;
          if (msg.kind === 'started') setDrainNote(t('drain_started'));
          else if (msg.kind === 'presigned') setDrainNote(t('drain_presigned'));
          else if (msg.kind === 'uploaded') setDrainNote(t('drain_uploaded'));
          else if (msg.kind === 'accepted') {
            setDrainNote(t('drain_accepted'));
            setLastAcceptedId(msg.submission_id);
          } else if (msg.kind === 'error') setDrainNote(t('drain_error', { error: msg.error }));
        });
      } catch {/* swallow; next tick retries */}
    };
    tick();
    const id = setInterval(tick, 5_000);
    // Trigger an immediate drain when connectivity returns; the SW
    // background-sync registration covers the tab-closed case.
    const onOnline = () => {
      tick();
    };
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof window !== 'undefined') window.removeEventListener('online', onOnline);
    };
  }, [t]);

  // Status poll: once a submission has been accepted, keep checking until
  // it reaches a terminal state, so the agent sees "extracted" or
  // "needs review" instead of stopping at "submitted".
  const [statusForLast, setStatusForLast] = useState<SubmissionStatus | null>(null);
  useEffect(() => {
    if (!lastAcceptedId) return;
    let cancelled = false;
    const id = setInterval(async () => {
      try {
        const s = await pollSubmission(lastAcceptedId);
        if (cancelled) return;
        setStatusForLast(s);
        if (s.processing_status === 'extracted' || s.processing_status === 'failed') {
          clearInterval(id);
        }
      } catch {/* keep trying */}
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [lastAcceptedId]);

  const doLogout = () => {
    logout();
    setAgent(null);
    setPhone('');
    setOtp('');
    setFile(null);
    setCapturedAt(null);
    setGps(null);
    setAuthError(null);
    setElections(null);
    setElectionId(null);
    setLastAcceptedId(null);
    setStatusForLast(null);
    setStep('phone');
  };

  if (step === 'phone') {
    return (
      <Shell title={t('phone_title')}>
        <p className="text-slate-600">{t('phone_lede')}</p>
        <input
          type="tel"
          inputMode="tel"
          placeholder={t('phone_placeholder')}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="mt-4 w-full border rounded px-4 py-3 text-lg"
        />
        {authError && (
          <p className="mt-3 text-sm text-red-700">
            {authError}
            {retryAfter ? ' ' + t('phone_retry_in', { seconds: retryAfter }) : ''}
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
              setAuthError(translateAuthError(err.code, t));
              setRetryAfter(
                (err.detail as { retry_after_seconds?: number })?.retry_after_seconds ?? null
              );
            } finally {
              setOtpRequesting(false);
            }
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {otpRequesting ? t('phone_sending') : t('phone_send')}
        </button>
      </Shell>
    );
  }

  if (step === 'otp') {
    return (
      <Shell title={t('otp_title')}>
        <p className="text-slate-600">{t('otp_lede', { phone })}</p>
        <input
          type="text"
          inputMode="numeric"
          placeholder={t('otp_placeholder')}
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
              setAuthError(translateAuthError(err.code, t));
            } finally {
              setOtpVerifying(false);
            }
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {otpVerifying ? t('otp_verifying') : t('otp_verify')}
        </button>
        <button
          onClick={() => {
            setOtp('');
            setAuthError(null);
            setStep('phone');
          }}
          className="mt-3 w-full text-slate-600 underline"
        >
          {t('otp_change_number')}
        </button>
      </Shell>
    );
  }

  if (step === 'pu' && agent) {
    const activeElections = elections ?? [];
    const hasMultiple = activeElections.length > 1;
    const noActive = elections !== null && activeElections.length === 0;
    const canContinue = !!agent.assigned_pu_code && !!electionId;

    return (
      <Shell title={t('pu_title')} onLogout={doLogout} logoutLabel={t('logout')}>
        <dl className="space-y-2 text-sm">
          <Row label={t('pu_name')} value={agent.full_name} />
          <Row label={t('pu_party')} value={agent.party_code ?? '—'} />
          <Row label={t('pu_code')} value={agent.assigned_pu_code ?? '—'} mono />
        </dl>
        {noActive && (
          <p className="mt-4 text-sm text-red-700">{t('pu_no_elections')}</p>
        )}
        {hasMultiple && (
          <label className="mt-4 block">
            <span className="text-sm text-slate-600">{t('pu_choose_election')}</span>
            <select
              value={electionId ?? ''}
              onChange={(e) => setElectionId(e.target.value || null)}
              className="mt-1 w-full border rounded px-3 py-2"
            >
              <option value="" disabled>
                —
              </option>
              {activeElections.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.election_type} · {e.id}
                </option>
              ))}
            </select>
          </label>
        )}
        {!hasMultiple && electionId && (
          <dl className="mt-2">
            <Row label={t('pu_election')} value={electionId} mono />
          </dl>
        )}
        <button
          disabled={!canContinue}
          onClick={() => setStep('capture')}
          className="mt-6 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {t('pu_take_photo')}
        </button>
        <p className="mt-3 text-xs text-slate-500">{t('pu_footnote')}</p>
        <QueuePanel onChange={setQueueDepth} />
      </Shell>
    );
  }

  if (step === 'capture' && agent) {
    return (
      <Shell title={t('capture_title')} onLogout={doLogout} logoutLabel={t('logout')}>
        <div className="text-sm text-slate-600 mb-3">{t('capture_lede')}</div>
        <label className="block border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:bg-slate-50">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              // Snapshot capture time at the moment the file lands in the
              // input, not at submit-time. This is what gets stored as
              // captured_at on the submission record.
              setCapturedAt(f ? new Date().toISOString() : null);
            }}
          />
          <div className="text-sm">
            {file ? t('capture_selected', { name: file.name }) : t('capture_open_camera')}
          </div>
        </label>
        <div className="mt-3 text-xs text-slate-500">
          {gps
            ? t('capture_gps_locked', {
                lat: gps.lat.toFixed(5),
                lng: gps.lng.toFixed(5),
                acc: Math.round(gps.acc),
              })
            : t('capture_gps_acquiring')}
        </div>
        <button
          disabled={!file}
          onClick={() => setStep('confirm')}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium disabled:opacity-40"
        >
          {t('capture_continue')}
        </button>
      </Shell>
    );
  }

  if (step === 'confirm' && file && agent && capturedAt) {
    return (
      <Shell title={t('confirm_title')} onLogout={doLogout} logoutLabel={t('logout')}>
        <img
          alt="EC8A preview"
          src={URL.createObjectURL(file)}
          className="w-full rounded border max-h-[60vh] object-contain"
        />
        <dl className="mt-3 space-y-1 text-sm">
          <Row label={t('confirm_pu')} value={agent.assigned_pu_code ?? '—'} mono />
          <Row
            label={t('confirm_gps')}
            value={gps ? `${gps.lat.toFixed(5)}, ${gps.lng.toFixed(5)}` : '—'}
          />
          <Row label={t('confirm_captured_at')} value={new Date(capturedAt).toLocaleString()} />
        </dl>
        <button
          onClick={async () => {
            const buf = await file.arrayBuffer();
            const sha = await computeSha256Hex(buf);
            if (!agent.assigned_pu_code) {
              setAuthError(t('err_no_pu_assigned'));
              return;
            }
            if (!electionId) {
              setAuthError(t('pu_no_elections'));
              return;
            }
            await OfflineQueue.enqueue({
              election_id: electionId,
              pu_code: agent.assigned_pu_code,
              source_type: 'party_agent',
              party_code: agent.party_code,
              image_blob: file,
              image_sha256: sha,
              image_bytes: file.size,
              gps,
              captured_at: capturedAt,
              client_submission_uuid:
                (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
                  ? (crypto as any).randomUUID()
                  : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            });
            // Tell the service worker to drain when network returns,
            // even if the tab is closed.
            await requestBackgroundSync();
            setStep('done');
          }}
          className="mt-5 w-full bg-ng-green text-white text-lg py-3 rounded font-medium"
        >
          {t('confirm_submit')}
        </button>
        <p className="mt-3 text-xs text-slate-500">{t('confirm_offline_note')}</p>
      </Shell>
    );
  }

  if (step === 'done') {
    const live = statusForLast?.processing_status;
    const finalLabel =
      live === 'extracted'
        ? t('done_status_extracted')
        : live === 'failed'
        ? t('done_status_failed', { error: statusForLast?.processing_error ?? '—' })
        : live === 'processing'
        ? t('done_status_processing')
        : live === 'queued'
        ? t('done_status_queued')
        : t('done_status_submitting');

    return (
      <Shell title={t('done_title')} onLogout={doLogout} logoutLabel={t('logout')}>
        <p className="text-sm font-medium">{finalLabel}</p>
        {drainNote && <p className="text-xs text-slate-500 mt-1">{drainNote}</p>}
        {statusForLast && (
          <dl className="mt-4 space-y-1 text-xs">
            <Row label={t('done_submission_id')} value={statusForLast.id.slice(0, 8) + '…'} mono />
            {statusForLast.confidence_score != null && (
              <Row
                label={t('done_confidence')}
                value={`${(statusForLast.confidence_score * 100).toFixed(0)}%`}
              />
            )}
            {statusForLast.review_status && (
              <Row label={t('done_review')} value={statusForLast.review_status} />
            )}
          </dl>
        )}
        {queueDepth > 1 && (
          <p className="mt-3 text-xs text-slate-500">
            {queueDepth - 1 === 1
              ? t('done_queue_remaining_one')
              : t('done_queue_remaining_many', { n: queueDepth - 1 })}
          </p>
        )}
        <button
          onClick={() => {
            setFile(null);
            setCapturedAt(null);
            setLastAcceptedId(null);
            setStatusForLast(null);
            setStep('pu');
          }}
          className="mt-5 w-full border py-3 rounded font-medium"
        >
          {t('done_continue')}
        </button>
        <QueuePanel onChange={setQueueDepth} />
      </Shell>
    );
  }

  return null;
}

function Shell({
  title,
  children,
  onLogout,
  logoutLabel,
}: {
  title: string;
  children: React.ReactNode;
  onLogout?: () => void;
  logoutLabel?: string;
}) {
  return (
    <div className="max-w-md mx-auto px-5 py-6">
      <div className="flex items-baseline justify-between mb-4">
        <h1 className="text-2xl font-bold">{title}</h1>
        {onLogout && (
          <button onClick={onLogout} className="text-xs text-slate-500 underline">
            {logoutLabel}
          </button>
        )}
      </div>
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

type Translator = ReturnType<typeof useTranslations>;

function translateAuthError(code: string, t: Translator): string {
  switch (code) {
    case 'phone_throttled':
      return t('err_phone_throttled');
    case 'ip_throttled':
      return t('err_ip_throttled');
    case 'no_active_otp':
      return t('err_no_active_otp');
    case 'expired':
      return t('err_expired');
    case 'code_mismatch':
      return t('err_code_mismatch');
    case 'too_many_attempts':
      return t('err_too_many_attempts');
    case 'already_consumed':
      return t('err_already_consumed');
    case 'phone_not_provisioned':
      return t('err_phone_not_provisioned');
    case 'device_change_required':
      return t('err_device_change_required');
    case 'invalid phone number':
    case 'unparseable phone':
      return t('err_invalid_phone');
    default:
      return t('err_generic');
  }
}
