/** LocalBusiness JSON-LD generation. */

import type { LocalBusiness, OpeningHours, PostalAddress } from '@agentready/shared';
import { localBusinessNode } from './generate.js';

export { localBusinessNode as buildLocalBusinessNode };

/** Common LocalBusiness subtypes; pick the most specific that is true. */
export const LOCAL_BUSINESS_TYPES = [
  'LocalBusiness',
  'Store',
  'Restaurant',
  'CafeOrCoffeeShop',
  'Bakery',
  'Bar',
  'ClothingStore',
  'Pharmacy',
  'Dentist',
  'Physician',
  'VeterinaryCare',
  'AutoRepair',
  'BeautySalon',
  'Gym',
  'TravelAgency',
  'RealEstateAgent',
  'LawService',
  'AccountingService',
  'InsuranceAgency',
  'Electrician',
  'Plumber',
  'HVACBusiness',
  'CleaningService',
] as const;

export function generateLocalBusiness(lb: LocalBusiness, siteUrl?: string): Record<string, unknown> {
  return localBusinessNode(lb as unknown as Record<string, unknown>, siteUrl ? { siteUrl } : {});
}

/** Full day names, indexed for range expansion. */
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

/** Map "mon", "Mon", "monday" -> the canonical full name, if it is a day. */
function normalizeDay(input: string): string | undefined {
  const d = input.trim().toLowerCase();
  if (DAYS.includes(d)) return d;
  const abbrev = d.slice(0, 3);
  return DAYS.find((day) => day.startsWith(abbrev) && abbrev.length >= 3);
}

/** Parse `"Mon-Fri 09:00-17:00"` into an OpeningHoursSpecification. */
export function parseOpeningHours(spec: string): OpeningHours[] {
  const out: OpeningHours[] = [];
  for (const chunk of spec.split(';')) {
    const m = /^\s*([A-Za-z,\-\s]+?)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/.exec(chunk);
    if (!m) continue;
    const rawDays = (m[1] ?? '').split(',').map((d) => d.trim()).filter(Boolean);

    // Expand ranges: "mon-fri" -> Monday..Friday, "sat" -> Saturday.
    const expanded: string[] = [];
    for (const d of rawDays) {
      const range = /^([a-z]+)\s*-\s*([a-z]+)$/i.exec(d);
      if (range) {
        const start = normalizeDay(range[1] ?? '');
        const end = normalizeDay(range[2] ?? '');
        if (start && end) {
          const a = DAYS.indexOf(start);
          const b = DAYS.indexOf(end);
          if (b >= a) for (let i = a; i <= b; i++) expanded.push(DAYS[i] as string);
        }
      } else {
        const day = normalizeDay(d);
        if (day && !expanded.includes(day)) expanded.push(day);
      }
    }

    if (expanded.length > 0) {
      out.push({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: expanded.map((d) => d[0]!.toUpperCase() + d.slice(1)),
        opens: m[2] as string,
        closes: m[3] as string,
      });
    }
  }
  return out;
}

/** Convenience builder for a single-location business. */
export function buildLocalBusiness(input: {
  type?: string;
  name: string;
  description?: string;
  url: string;
  telephone?: string;
  email?: string;
  image?: string;
  priceRange?: string;
  address: PostalAddress;
  geo?: { latitude: number; longitude: number };
  openingHours?: string;
  sameAs?: string[];
}): LocalBusiness {
  return {
    '@type': input.type ?? 'LocalBusiness',
    name: input.name,
    url: input.url,
    address: input.address,
    ...(input.description ? { description: input.description } : {}),
    ...(input.telephone ? { telephone: input.telephone } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.image ? { image: input.image } : {}),
    ...(input.priceRange ? { priceRange: input.priceRange } : {}),
    ...(input.geo ? { geo: input.geo } : {}),
    ...(input.openingHours ? { openingHoursSpecification: parseOpeningHours(input.openingHours) } : {}),
    ...(input.sameAs ? { sameAs: input.sameAs } : {}),
  };
}