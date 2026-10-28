'use strict';
/* Country dial codes for the phone field (all countries).
   Admin can block countries via setting `blocked_phone_countries` (comma-separated ISO codes).
   Blocked countries are removed from the dropdown AND rejected server-side on register. */
const COUNTRIES = [
  ['AF', 'Afghanistan', '93'], ['AL', 'Albania', '355'], ['DZ', 'Algeria', '213'], ['AD', 'Andorra', '376'],
  ['AO', 'Angola', '244'], ['AG', 'Antigua and Barbuda', '1'], ['AR', 'Argentina', '54'], ['AM', 'Armenia', '374'],
  ['AU', 'Australia', '61'], ['AT', 'Austria', '43'], ['AZ', 'Azerbaijan', '994'], ['BS', 'Bahamas', '1'],
  ['BH', 'Bahrain', '973'], ['BD', 'Bangladesh', '880'], ['BB', 'Barbados', '1'], ['BY', 'Belarus', '375'],
  ['BE', 'Belgium', '32'], ['BZ', 'Belize', '501'], ['BJ', 'Benin', '229'], ['BT', 'Bhutan', '975'],
  ['BO', 'Bolivia', '591'], ['BA', 'Bosnia and Herzegovina', '387'], ['BW', 'Botswana', '267'], ['BR', 'Brazil', '55'],
  ['BN', 'Brunei', '673'], ['BG', 'Bulgaria', '359'], ['BF', 'Burkina Faso', '226'], ['BI', 'Burundi', '257'],
  ['KH', 'Cambodia', '855'], ['CM', 'Cameroon', '237'], ['CA', 'Canada', '1'], ['CV', 'Cape Verde', '238'],
  ['CF', 'Central African Republic', '236'], ['TD', 'Chad', '235'], ['CL', 'Chile', '56'], ['CN', 'China', '86'],
  ['CO', 'Colombia', '57'], ['KM', 'Comoros', '269'], ['CG', 'Congo', '242'], ['CD', 'Congo (DRC)', '243'],
  ['CR', 'Costa Rica', '506'], ['HR', 'Croatia', '385'], ['CU', 'Cuba', '53'], ['CY', 'Cyprus', '357'],
  ['CZ', 'Czech Republic', '420'], ['DK', 'Denmark', '45'], ['DJ', 'Djibouti', '253'], ['DM', 'Dominica', '1'],
  ['DO', 'Dominican Republic', '1'], ['EC', 'Ecuador', '593'], ['EG', 'Egypt', '20'], ['SV', 'El Salvador', '503'],
  ['GQ', 'Equatorial Guinea', '240'], ['ER', 'Eritrea', '291'], ['EE', 'Estonia', '372'], ['SZ', 'Eswatini', '268'],
  ['ET', 'Ethiopia', '251'], ['FJ', 'Fiji', '679'], ['FI', 'Finland', '358'], ['FR', 'France', '33'],
  ['GA', 'Gabon', '241'], ['GM', 'Gambia', '220'], ['GE', 'Georgia', '995'], ['DE', 'Germany', '49'],
  ['GH', 'Ghana', '233'], ['GR', 'Greece', '30'], ['GD', 'Grenada', '1'], ['GT', 'Guatemala', '502'],
  ['GN', 'Guinea', '224'], ['GW', 'Guinea-Bissau', '245'], ['GY', 'Guyana', '592'], ['HT', 'Haiti', '509'],
  ['HN', 'Honduras', '504'], ['HU', 'Hungary', '36'], ['IS', 'Iceland', '354'], ['IN', 'India', '91'],
  ['ID', 'Indonesia', '62'], ['IR', 'Iran', '98'], ['IQ', 'Iraq', '964'], ['IE', 'Ireland', '353'],
  ['IL', 'Israel', '972'], ['IT', 'Italy', '39'], ['JM', 'Jamaica', '1'], ['JP', 'Japan', '81'],
  ['JO', 'Jordan', '962'], ['KZ', 'Kazakhstan', '7'], ['KE', 'Kenya', '254'], ['KI', 'Kiribati', '686'],
  ['KW', 'Kuwait', '965'], ['KG', 'Kyrgyzstan', '996'], ['LA', 'Laos', '856'], ['LV', 'Latvia', '371'],
  ['LB', 'Lebanon', '961'], ['LS', 'Lesotho', '266'], ['LR', 'Liberia', '231'], ['LY', 'Libya', '218'],
  ['LI', 'Liechtenstein', '423'], ['LT', 'Lithuania', '370'], ['LU', 'Luxembourg', '352'], ['MG', 'Madagascar', '261'],
  ['MW', 'Malawi', '265'], ['MY', 'Malaysia', '60'], ['MV', 'Maldives', '960'], ['ML', 'Mali', '223'],
  ['MT', 'Malta', '356'], ['MR', 'Mauritania', '222'], ['MU', 'Mauritius', '230'], ['MX', 'Mexico', '52'],
  ['MD', 'Moldova', '373'], ['MC', 'Monaco', '377'], ['MN', 'Mongolia', '976'], ['ME', 'Montenegro', '382'],
  ['MA', 'Morocco', '212'], ['MZ', 'Mozambique', '258'], ['MM', 'Myanmar', '95'], ['NA', 'Namibia', '264'],
  ['NR', 'Nauru', '674'], ['NP', 'Nepal', '977'], ['NL', 'Netherlands', '31'], ['NZ', 'New Zealand', '64'],
  ['NI', 'Nicaragua', '505'], ['NE', 'Niger', '227'], ['NG', 'Nigeria', '234'], ['MK', 'North Macedonia', '389'],
  ['NO', 'Norway', '47'], ['OM', 'Oman', '968'], ['PK', 'Pakistan', '92'], ['PW', 'Palau', '680'],
  ['PS', 'Palestine', '970'], ['PA', 'Panama', '507'], ['PG', 'Papua New Guinea', '675'], ['PY', 'Paraguay', '595'],
  ['PE', 'Peru', '51'], ['PH', 'Philippines', '63'], ['PL', 'Poland', '48'], ['PT', 'Portugal', '351'],
  ['QA', 'Qatar', '974'], ['RO', 'Romania', '40'], ['RU', 'Russia', '7'], ['RW', 'Rwanda', '250'],
  ['KN', 'Saint Kitts and Nevis', '1'], ['LC', 'Saint Lucia', '1'], ['VC', 'Saint Vincent', '1'],
  ['WS', 'Samoa', '685'], ['SM', 'San Marino', '378'], ['ST', 'Sao Tome and Principe', '239'],
  ['SA', 'Saudi Arabia', '966'], ['SN', 'Senegal', '221'], ['RS', 'Serbia', '381'], ['SC', 'Seychelles', '248'],
  ['SL', 'Sierra Leone', '232'], ['SG', 'Singapore', '65'], ['SK', 'Slovakia', '421'], ['SI', 'Slovenia', '386'],
  ['SB', 'Solomon Islands', '677'], ['SO', 'Somalia', '252'], ['ZA', 'South Africa', '27'], ['SS', 'South Sudan', '211'],
  ['ES', 'Spain', '34'], ['LK', 'Sri Lanka', '94'], ['SD', 'Sudan', '249'], ['SR', 'Suriname', '597'],
  ['SE', 'Sweden', '46'], ['CH', 'Switzerland', '41'], ['SY', 'Syria', '963'], ['TW', 'Taiwan', '886'],
  ['TJ', 'Tajikistan', '992'], ['TZ', 'Tanzania', '255'], ['TH', 'Thailand', '66'], ['TG', 'Togo', '228'],
  ['TO', 'Tonga', '676'], ['TT', 'Trinidad and Tobago', '1'], ['TN', 'Tunisia', '216'], ['TR', 'Turkey', '90'],
  ['TM', 'Turkmenistan', '993'], ['TV', 'Tuvalu', '688'], ['UG', 'Uganda', '256'], ['UA', 'Ukraine', '380'],
  ['AE', 'United Arab Emirates', '971'], ['GB', 'United Kingdom', '44'], ['US', 'United States', '1'],
  // R-033: ISO 3166 territories + KR/HK/MO that were missing (their users
  // were fail-closed blocked from registering at all).
  ['KR', 'South Korea', '82'], ['HK', 'Hong Kong', '852'], ['MO', 'Macau', '853'],
  ['PR', 'Puerto Rico', '1787'], ['GU', 'Guam', '1671'], ['VI', 'U.S. Virgin Islands', '1340'],
  ['AS', 'American Samoa', '1684'], ['MP', 'Northern Mariana Islands', '1670'],
  ['BM', 'Bermuda', '1441'], ['KY', 'Cayman Islands', '1345'], ['TC', 'Turks and Caicos Islands', '1649'],
  ['VG', 'British Virgin Islands', '1284'], ['AI', 'Anguilla', '1264'], ['MS', 'Montserrat', '1664'],
  ['SH', 'Saint Helena', '290'], ['FK', 'Falkland Islands', '500'], ['GI', 'Gibraltar', '350'],
  ['JE', 'Jersey', '44'], ['GG', 'Guernsey', '44'], ['IM', 'Isle of Man', '44'],
  ['FO', 'Faroe Islands', '298'], ['GL', 'Greenland', '299'], ['AX', 'Aland Islands', '358'],
  ['SJ', 'Svalbard and Jan Mayen', '47'], ['AQ', 'Antarctica', '672'], ['BV', 'Bouvet Island', '47'],
  ['HM', 'Heard Island and McDonald Islands', '672'], ['CC', 'Cocos (Keeling) Islands', '61'],
  ['CX', 'Christmas Island', '61'], ['NF', 'Norfolk Island', '672'], ['NU', 'Niue', '683'],
  ['TK', 'Tokelau', '690'], ['WF', 'Wallis and Futuna', '681'], ['PN', 'Pitcairn', '64'],
  ['CK', 'Cook Islands', '682'], ['GS', 'South Georgia', '500'], ['IO', 'British Indian Ocean Territory', '246'],
  ['TF', 'French Southern Territories', '262'], ['UM', 'U.S. Minor Outlying Islands', '1'],
  ['EH', 'Western Sahara', '212'], ['XK', 'Kosovo', '383'], ['NC', 'New Caledonia', '687'],
  ['PF', 'French Polynesia', '689'], ['YT', 'Mayotte', '262'], ['RE', 'Reunion', '262'],
  ['MQ', 'Martinique', '596'], ['GP', 'Guadeloupe', '590'], ['BL', 'Saint Barthelemy', '590'],
  ['MF', 'Saint Martin (French)', '590'], ['PM', 'Saint Pierre and Miquelon', '508'],
  ['CW', 'Curacao', '599'], ['SX', 'Sint Maarten', '1721'], ['BQ', 'Bonaire', '599'], ['AW', 'Aruba', '297'],
  ['UY', 'Uruguay', '598'], ['UZ', 'Uzbekistan', '998'], ['VU', 'Vanuatu', '678'], ['VA', 'Vatican City', '379'],
  ['VE', 'Venezuela', '58'], ['VN', 'Vietnam', '84'], ['YE', 'Yemen', '967'], ['ZM', 'Zambia', '260'],
  ['ZW', 'Zimbabwe', '263'],
].map(([iso, name, dial]) => ({ iso, name, dial }));
function blockedSet(settings) {
  const { getS } = require('./settings');
  return new Set(String(getS(settings, 'blocked_phone_countries', '') || '').split(',').map(x => x.trim().toUpperCase()).filter(Boolean));
}
function allowedCountries(settings) {
  const blocked = blockedSet(settings);
  return COUNTRIES.filter(c => !blocked.has(c.iso));
}
function countryForDialNumber(settings, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // Longest dial match first. A dial shared by several countries (1 = NANP,
  // 7 = RU/KZ, ...) CANNOT be attributed to one country from digits alone,
  // so an ambiguous match returns null instead of a silently wrong country
  // (the old code returned the first list entry — +1 always meant Antigua).
  const matches = [...COUNTRIES].filter(c => digits.startsWith(c.dial));
  if (!matches.length) return null;
  const longest = Math.max(...matches.map(c => c.dial.length));
  const best = matches.filter(c => c.dial.length === longest);
  return best.length === 1 ? best[0] : null;
}
function isBlockedPhone(settings, phone, countryIso) {
  const blocked = blockedSet(settings);
  // An explicitly supplied country can only ADD a block, never bypass the
  // dial check (the value is user-supplied at registration).
  if (countryIso && blocked.has(String(countryIso).toUpperCase())) return true;
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return false;
  const matches = COUNTRIES.filter(c => digits.startsWith(c.dial));
  // Unknown dial: fail closed rather than letting an unlisted number through.
  if (!matches.length) return true;
  // Only the LONGEST matching dial group counts (so a future sub-dial like
  // 1242 would not be swallowed by the bare '1' group). Within that group,
  // blocking ANY member blocks the range: blocking US must block +1 numbers,
  // and blocking Antigua blocks +1 too — inherent to dial-based blocking,
  // and now consistent instead of depending on list order.
  const longest = Math.max(...matches.map(c => c.dial.length));
  return matches.filter(c => c.dial.length === longest).some(c => blocked.has(c.iso));
}
module.exports = { COUNTRIES, allowedCountries, blockedSet, countryForDialNumber, isBlockedPhone };
