/**
 * Seed catalogue for the demo store.
 *
 * Deliberately varied: some products out of stock, one pre-order, mixed
 * categories and specs. A demo where everything is in stock and identical
 * teaches the wrong thing.
 */


export const ORGANIZATION = {
  name: 'Northwind Supply',
  slug: 'northwind-supply',
  initial: 'N',
  tagline: 'field-tested equipment for people who work',
  description:
    'Northwind Supply sells durable field equipment — laptops, power banks, cases and cabling — with public pricing, live stock data and a machine-readable API.',
  email: 'api@northwind.example',
  sameAs: ['https://github.com/northwind-supply', 'https://twitter.com/northwindsupply'],
};

/** 14 products across 5 categories, in USD. */
export const PRODUCTS = [
  {
    id: 'atlas-laptop-14',
    name: 'Atlas 14" Field Laptop',
    description:
      'A 14-inch laptop built for outdoor and mobile work. 32GB RAM, 1TB SSD, daylight-readable 1600 nits display, and a chassis rated to survive 40 drops from desk height.',
    sku: 'NW-ATLAS-14',
    category: 'Computing',
    price: 1299,
    availability: 'InStock',
    specs: { Display: '14in 1600 nits', RAM: '32GB', Storage: '1TB NVMe SSD', Battery: '18 hours', Weight: '1.4 kg', Ports: '2x USB-C, 2x USB-A, HDMI, microSD' },
    rating: { value: 4.6, count: 218 },
  },
  {
    id: 'atlas-laptop-16',
    name: 'Atlas 16" Field Laptop',
    description:
      'The 16-inch Atlas, for work that needs a real keyboard and more screen. Same rugged chassis, discrete graphics option, and a serviceable battery.',
    sku: 'NW-ATLAS-16',
    category: 'Computing',
    price: 1799,
    availability: 'InStock',
    specs: { Display: '16in 1600 nits', RAM: '32GB', Storage: '1TB NVMe SSD', Battery: '14 hours', Weight: '2.1 kg', Graphics: 'Optional discrete GPU' },
    rating: { value: 4.4, count: 96 },
  },
  {
    id: 'titan-powerbank-100',
    name: 'Titan 100W Power Bank',
    description:
      'A 27,000mAh power bank that charges a laptop at 100W. Pass-through charging means you can use it while it fills. IP67 rated.',
    sku: 'NW-TITAN-100',
    category: 'Power',
    price: 129,
    availability: 'InStock',
    specs: { Capacity: '27,000mAh', Output: '100W USB-C PD', Rating: 'IP67', Weight: '640 g', Ports: '2x USB-C, 1x USB-A' },
    rating: { value: 4.7, count: 1_042 },
  },
  {
    id: 'titan-powerbank-65',
    name: 'Titan 65W Power Bank',
    description:
      'A smaller 15,000mAh bank that still charges a laptop at 65W. The one to carry when weight matters more than headroom.',
    sku: 'NW-TITAN-65',
    category: 'Power',
    price: 79,
    availability: 'InStock',
    specs: { Capacity: '15,000mAh', Output: '65W USB-C PD', Rating: 'IP65', Weight: '350 g', Ports: '1x USB-C, 1x USB-A' },
    rating: { value: 4.5, count: 640 },
  },
  {
    id: 'solarfold-panel',
    name: 'SolarFold 60W Panel',
    description:
      'A folding 60W solar panel with USB-C PD output. Charges a power bank directly in daylight, no controller needed.',
    sku: 'NW-SOLAR-60',
    category: 'Power',
    price: 189,
    availability: 'BackOrder',
    specs: { Output: '60W', Folded: '32 x 24 cm', Weight: '2.4 kg', Ports: 'USB-C PD, DC barrel' },
  },
  {
    id: 'pelican-case-20',
    name: 'Pelican 20L Field Case',
    description:
      'A hard-shell case with a custom foam insert, rated to 30m of freshwater immersion. The default case in our kits.',
    sku: 'NW-PELICAN-20',
    category: 'Protection',
    price: 89,
    availability: 'InStock',
    specs: { Volume: '20 litres', Rating: 'IP68', Weight: '2.8 kg', Foam: 'Custom cut', Seal: 'Automatic pressure equalisation' },
    rating: { value: 4.8, count: 312 },
  },
  {
    id: 'pelican-case-45',
    name: 'Pelican 45L Field Case',
    description:
      'The 45-litre version, for kits that carry a full day of equipment plus spares. Same IP68 rating and pressure-equalising seal.',
    sku: 'NW-PELICAN-45',
    category: 'Protection',
    price: 139,
    availability: 'InStock',
    specs: { Volume: '45 litres', Rating: 'IP68', Weight: '4.6 kg', Foam: 'Custom cut', Seal: 'Automatic pressure equalisation' },
  },
  {
    id: 'stormproof-rain-shell',
    name: 'Stormproof Rain Shell',
    description:
      'A three-layer waterproof shell rated to 20,000mm. Taped seams, pit zips, and a hood that fits over a helmet.',
    sku: 'NW-STORM-M',
    category: 'Apparel',
    price: 249,
    availability: 'InStock',
    specs: { Waterproof: '20,000mm', Breathability: '15,000g/m2/24h', Weight: '340 g', Sizes: 'XS-XXL', Colours: 'Graphite, Signal Orange, Field Green' },
    rating: { value: 4.3, count: 187 },
  },
  {
    id: 'stormproof-rain-pants',
    name: 'Stormproof Rain Trousers',
    description:
      'Full-length side zips so you can get them on over boots, and reinforced knees. Matches the shell.',
    sku: 'NW-STORMP-M',
    category: 'Apparel',
    price: 159,
    availability: 'InStock',
    specs: { Waterproof: '20,000mm', Weight: '280 g', Sizes: 'XS-XXL', Colours: 'Graphite, Signal Orange, Field Green', Features: 'Full side zips, reinforced knees' },
  },
  {
    id: 'grip-gloves',
    name: 'Grip Gloves (Pairs)',
    description:
      'Cut-resistant level C gloves with a nitrile palm. Work on a laptop in the rain and keep your hands warm and dry.',
    sku: 'NW-GRIP-L',
    category: 'Apparel',
    price: 39,
    availability: 'InStock',
    specs: { Cut: 'Level C (EN388)', Palm: 'Nitrile', Sizes: 'S-XXL', Cuff: 'Elastic', Pack: 'Sold as a pair' },
  },
  {
    id: 'braided-usbc-cable-2m',
    name: 'Braided USB-C Cable 2m',
    description:
      'A 240W-rated USB-C cable with a braided sheath and moulded strain relief. Stays flexible in cold weather.',
    sku: 'NW-CBL-2M',
    category: 'Cabling',
    price: 24,
    availability: 'InStock',
    specs: { Length: '2 metres', Power: '240W PD', Data: '40Gbps', Sheath: 'Braided nylon', Warranty: '5 years' },
    rating: { value: 4.9, count: 2_310 },
  },
  {
    id: 'braided-usbc-cable-05',
    name: 'Braided USB-C Cable 0.5m',
    description: 'A 30cm cable for charging at a desk or in a vehicle. Same 240W rating and braided sheath.',
    sku: 'NW-CBL-05',
    category: 'Cabling',
    price: 14,
    availability: 'InStock',
    specs: { Length: '0.5 metres', Power: '240W PD', Data: '40Gbps', Sheath: 'Braided nylon', Warranty: '5 years' },
  },
  {
    id: 'ethernet-cable-10m',
    name: 'Shielded Ethernet Cable 10m',
    description:
      'Cat6A shielded cable for fixed installations where Wi-Fi is not an option. 10 metres, snagless connectors.',
    sku: 'NW-ETH-10',
    category: 'Cabling',
    price: 42,
    availability: 'OutOfStock',
    specs: { Length: '10 metres', Category: 'Cat6A', Shielding: 'Screened', Connectors: 'Snagless', Rating: '750MHz' },
  },
  {
    id: 'hdmi-2-1-cable-2m',
    name: 'HDMI 2.1 Cable 2m',
    description:
      'Certified Ultra High Speed HDMI 2.1 cable, 8K at 60Hz. Includes a right-angle adapter in the box.',
    sku: 'NW-HDMI-2M',
    category: 'Cabling',
    price: 29,
    availability: 'PreOrder',
    specs: { Length: '2 metres', Standard: 'HDMI 2.1 Ultra High Speed', Bandwidth: '48Gbps', Includes: 'Right-angle adapter' },
  },
];

export const CATEGORIES = [...new Set(PRODUCTS.map((p) => p.category))];

export const CURRENCY = 'USD';