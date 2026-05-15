import { NextRequest } from 'next/server';

import { jsonOk } from '@/lib/api';
import { isMockMode, mockAnomalies } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const electionId = req.nextUrl.searchParams.get('election_id') ?? '2027-presidential';
  const state = req.nextUrl.searchParams.get('state');
  const type = req.nextUrl.searchParams.get('type');
  const minSeverity = parseInt(req.nextUrl.searchParams.get('min_severity') ?? '1', 10);

  if (isMockMode()) {
    let all = mockAnomalies();
    if (state) all = all.filter((a) => a.state_code === state);
    if (type) all = all.filter((a) => a.anomaly_type === type);
    all = all.filter((a) => a.severity >= minSeverity);
    return jsonOk(all);
  }

  let q = supabaseAdmin()
    .from('v_anomaly_register')
    .select('*')
    .eq('election_id', electionId)
    .gte('severity', minSeverity)
    .order('severity', { ascending: false })
    .order('detected_at', { ascending: false })
    .limit(500);
  if (state) q = q.eq('state_code', state);
  if (type) q = q.eq('anomaly_type', type);

  const { data, error } = await q;
  if (error) return jsonOk([]);
  return jsonOk(data ?? []);
}
