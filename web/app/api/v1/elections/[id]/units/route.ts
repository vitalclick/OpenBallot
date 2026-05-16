import { NextRequest } from 'next/server';

import { jsonOk } from '@/lib/api';
import { isMockMode, mockPollingUnits } from '@/lib/mock-data';
import { supabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

interface Params { params: { id: string } }

export async function GET(req: NextRequest, { params }: Params) {
  const state = req.nextUrl.searchParams.get('state');
  const lga = req.nextUrl.searchParams.get('lga');
  const ward = req.nextUrl.searchParams.get('ward');
  const pu = req.nextUrl.searchParams.get('pu');
  if (isMockMode()) {
    const all = mockPollingUnits();
    let filtered = all;
    if (state) filtered = filtered.filter((u) => u.state_code === state);
    if (lga)   filtered = filtered.filter((u) => u.lga_code === lga);
    if (ward)  filtered = filtered.filter((u) => u.ward_code === ward);
    if (pu)    filtered = filtered.filter((u) => u.pu_code === pu);
    return jsonOk(filtered);
  }
  let q = supabaseAdmin().from('v_pu_live_status').select('*').eq('election_id', params.id);
  if (state) q = q.eq('state_code', state);
  if (lga)   q = q.eq('lga_code', lga);
  if (ward)  q = q.eq('ward_code', ward);
  if (pu)    q = q.eq('pu_code', pu);
  const { data, error } = await q.limit(5000);
  if (error) return jsonOk([]);
  return jsonOk(data ?? []);
}
