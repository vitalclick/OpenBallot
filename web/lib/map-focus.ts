// Hierarchical map focus state for the public results map.
//
// The map is one of four "levels":
//   country -> render 37 state aggregates as proportional symbols
//   state   -> render LGAs of the focused state
//   lga     -> render wards of the focused LGA
//   ward    -> render individual polling units (5..~282)
//
// Each level carries the codes/names of the ancestors so the breadcrumb
// can render the full trail (Nigeria > Lagos > Alimosho > Ikotun/Ijegun)
// without re-fetching anything.

export type MapFocus =
  | { level: 'country' }
  | { level: 'state'; state_code: string; state_name: string }
  | {
      level: 'lga';
      state_code: string; state_name: string;
      lga_code: string;   lga_name: string;
    }
  | {
      level: 'ward';
      state_code: string; state_name: string;
      lga_code: string;   lga_name: string;
      ward_code: string;  ward_name: string;
    };

export const COUNTRY_FOCUS: MapFocus = { level: 'country' };

// Which aggregate level the renderer should request given a focus.
// At country focus we draw states; at state focus we draw LGAs; etc.
// At ward focus we don't fetch aggregates - we fetch the PUs directly.
export function aggregateLevelFor(focus: MapFocus): 'state' | 'lga' | 'ward' | null {
  switch (focus.level) {
    case 'country': return 'state';
    case 'state':   return 'lga';
    case 'lga':     return 'ward';
    case 'ward':    return null;
  }
}

export function parentCodeFor(focus: MapFocus): string | null {
  switch (focus.level) {
    case 'country': return null;
    case 'state':   return focus.state_code;
    case 'lga':     return focus.lga_code;
    case 'ward':    return focus.ward_code;
  }
}

// Climb one level up. Used by breadcrumb back buttons.
export function ascend(focus: MapFocus): MapFocus {
  switch (focus.level) {
    case 'country': return focus;
    case 'state':   return { level: 'country' };
    case 'lga':
      return { level: 'state', state_code: focus.state_code, state_name: focus.state_name };
    case 'ward':
      return {
        level: 'lga',
        state_code: focus.state_code, state_name: focus.state_name,
        lga_code: focus.lga_code,     lga_name: focus.lga_name,
      };
  }
}

// Drill into a child region. The caller already knows the names/codes of
// the parent chain because the row carries them.
export function descend(
  focus: MapFocus,
  child: { code: string; name: string; state_code: string }
): MapFocus {
  switch (focus.level) {
    case 'country':
      return { level: 'state', state_code: child.code, state_name: child.name };
    case 'state':
      return {
        level: 'lga',
        state_code: focus.state_code, state_name: focus.state_name,
        lga_code: child.code,         lga_name: child.name,
      };
    case 'lga':
      return {
        level: 'ward',
        state_code: focus.state_code, state_name: focus.state_name,
        lga_code: focus.lga_code,     lga_name: focus.lga_name,
        ward_code: child.code,        ward_name: child.name,
      };
    case 'ward':
      return focus;
  }
}

// Serialise focus into URL search params so refreshing the page (or
// sharing a link) restores the exact view. Only codes are stored; names
// are looked up from the aggregate row on hydration.
export function focusToParams(focus: MapFocus): Record<string, string> {
  switch (focus.level) {
    case 'country': return {};
    case 'state':   return { state: focus.state_code };
    case 'lga':     return { state: focus.state_code, lga: focus.lga_code };
    case 'ward':
      return { state: focus.state_code, lga: focus.lga_code, ward: focus.ward_code };
  }
}
