// Anytime Fitness KL/Selangor branches. handle = Instagram username.
// lat/lng are approximate (mall-level) — only used to sort by distance to Kepong.
// ponytail: rough coords are plenty for proximity ordering; no geocoding needed.
export type Location = {
  handle: string;
  name: string;
  lat: number;
  lng: number;
};

// Aeon Metro Prima, Kepong — the reference point.
export const KEPONG = { lat: 3.2107, lng: 101.632 };

export const LOCATIONS: Location[] = [
  // --- original set ---
  {
    handle: "afaeonmetroprimakepong",
    name: "Aeon Metro Prima Kepong",
    lat: 3.2107,
    lng: 101.632,
  },
  {
    handle: "anytimefitnessdesapark",
    name: "Desa ParkCity",
    lat: 3.1865,
    lng: 101.632,
  },
  {
    handle: "anytimefitness.selayang",
    name: "168 Park Selayang",
    lat: 3.247,
    lng: 101.65,
  },
  { handle: "af.sridamansara", name: "Sri Damansara", lat: 3.2, lng: 101.62 },
  {
    handle: "anytimefitnessglodamansarattdi",
    name: "Glo Damansara TTDI",
    lat: 3.149,
    lng: 101.63,
  },
  { handle: "af.klgcc", name: "KLGCC Bukit Kiara", lat: 3.148, lng: 101.632 },
  {
    handle: "anytimefitness.publika",
    name: "Publika Solaris Dutamas",
    lat: 3.1718,
    lng: 101.665,
  },
  {
    handle: "afcentrepointbandarutama",
    name: "Bandar Utama Centrepoint",
    lat: 3.148,
    lng: 101.615,
  },
  {
    handle: "af.mutiaradamansara",
    name: "Mutiara Damansara",
    lat: 3.156,
    lng: 101.61,
  },
  {
    handle: "anytimefitness.damansarajaya",
    name: "Damansara Jaya, Atria",
    lat: 3.133,
    lng: 101.623,
  },
  {
    handle: "af.sunsuriaavenue",
    name: "Sunsuria Avenue, Kota Damansara",
    lat: 3.156,
    lng: 101.587,
  },
  { handle: "af.ss2.petalingjaya", name: "SS2 PJ", lat: 3.117, lng: 101.624 },
  {
    handle: "anytimefitnessbangsar",
    name: "UOA Bangsar",
    lat: 3.129,
    lng: 101.678,
  },
  {
    handle: "afklgatewaybangsarsouth",
    name: "KL Gateway, Bangsar South",
    lat: 3.112,
    lng: 101.665,
  },
  {
    handle: "af.uniontower.tamandesa",
    name: "Union Tower, Taman Desa",
    lat: 3.105,
    lng: 101.684,
  },
  {
    handle: "anytimefitness.sripetaling",
    name: "Sri Petaling",
    lat: 3.068,
    lng: 101.689,
  },
  {
    handle: "aftropikabukitjalil",
    name: "Bukit Jalil (The Tropika)",
    lat: 3.058,
    lng: 101.69,
  },

  // --- added (web-verified IG profiles) ---
  {
    handle: "af.plazamontkiara",
    name: "Plaza Mont Kiara",
    lat: 3.172,
    lng: 101.652,
  },
  {
    handle: "af.themet.montkiara",
    name: "The MET, Mont Kiara",
    lat: 3.182,
    lng: 101.655,
  },
  { handle: "af.therivercity", name: "River City", lat: 3.197, lng: 101.683 },
  {
    handle: "anytimefitnesstraderspark",
    name: "Traders Park, Cheras",
    lat: 3.1,
    lng: 101.748,
  },
  {
    handle: "anytimefitness.pearlpoint",
    name: "Pearl Point, Old Klang Road",
    lat: 3.09,
    lng: 101.668,
  },
  {
    handle: "anytimefitness.kinrara",
    name: "Bandar Kinrara, Puchong",
    lat: 3.045,
    lng: 101.645,
  },
  {
    handle: "af.setiawalk.puchong",
    name: "Setiawalk Puchong",
    lat: 3.03,
    lng: 101.625,
  },
  {
    handle: "anytimefitness.bandarputeri",
    name: "Bandar Puteri Puchong (IOI Rio)",
    lat: 3.025,
    lng: 101.62,
  },
  {
    handle: "anytimefitness.ss15",
    name: "SS15 Courtyard, Subang Jaya",
    lat: 3.075,
    lng: 101.587,
  },
  {
    handle: "af.megahrise",
    name: "Megah Rise, Taman Megah",
    lat: 3.1142,
    lng: 101.6147,
  },
  {
    handle: "anytimefitness.brp.sungaibuloh",
    name: "Bukit Rahman Putra, Sungai Buloh",
    lat: 3.219,
    lng: 101.566,
  },
  {
    handle: "af.wismamcis_pj",
    name: "Wisma MCIS, PJ",
    lat: 3.106,
    lng: 101.643,
  },
  {
    handle: "af.yolosignaturesuites",
    name: "YOLO Signature Suites, Bandar Sunway",
    lat: 3.067,
    lng: 101.606,
  },
  {
    handle: "af_platinumarena",
    name: "Platinum Arena, Old Klang Road",
    lat: 3.094,
    lng: 101.676,
  },
];
