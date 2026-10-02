import { COUNTRY_CURRENCIES } from '../../../shared/commerce/canonical-order.rules';
import { PhoneService } from '../../../shared/services/phone.service';
import { detectPhoneCountry, type PhoneCountryDeps } from './phone-country';

const phones = new PhoneService();
const deps: PhoneCountryDeps = {
  standardizeMobile: (phone, country) =>
    phones.standardizeMobile(phone, country),
  callingCodeOf: (country) => phones.callingCode(country),
};
/** As upload asks: the fallback first, then every other supported country. */
const candidates = (fallback: string) => [
  fallback,
  ...Object.keys(COUNTRY_CURRENCIES).filter((country) => country !== fallback),
];
const detect = (cells: string[], fallback = 'EG') =>
  detectPhoneCountry(cells, candidates(fallback), deps);

describe('detectPhoneCountry', () => {
  it('reads a Saudi file in its three spellings as Saudi', () => {
    expect(
      detect([
        '501039595',
        '966531047514',
        '966551055433',
        '966561063352',
        '+966 59 107 1234',
        '501079190',
        '966531087109',
        '966551095028',
        '966561102947',
        '+966 59 111 0856',
      ]),
    ).toBe('SA');
  });

  it('reads an Egyptian file as Egyptian, lost zero and bare code included', () => {
    expect(
      detect(['01012345678', '1112345678', '201212345678', '0100 123 4567']),
    ).toBe('EG');
    expect(detect(['01012345678', '1112345678'], 'SA')).toBe('EG');
  });

  it('reads an Emirati file as Emirati, though `050…` is Saudi too', () => {
    expect(
      detect([
        '0501055433',
        '+971521063352',
        '00971541071271',
        '971551079190',
        '+971 56 108 7109',
        '0501095028',
      ]),
    ).toBe('AE');
  });

  it('reads a Jordanian file as Jordanian', () => {
    expect(detect(['771063352', '962781071271', '+962 78 109 5028'])).toBe(
      'JO',
    );
  });

  it('counts a number with its own code for that country only', () => {
    expect(detect(['+971501234567', '00971521234567'])).toBe('AE');
  });

  it('goes with the majority of a mixed file', () => {
    expect(detect(['01012345678', '+966501234567', '0501234567'], 'SA')).toBe(
      'SA',
    );
  });

  it('gives a tie to the earlier candidate', () => {
    // A local Saudi and Emirati mobile are written alike.
    const cells = ['501234567', '551234567'];
    expect(detect(cells, 'AE')).toBe('AE');
    expect(detect(cells, 'SA')).toBe('SA');
    expect(detect(cells, 'EG')).toBe('SA');
  });

  it('says nothing when no phone reads as a mobile anywhere', () => {
    expect(detect([])).toBeNull();
    expect(detect(['', '   ', 'n/a', '12345', '2.01012E+11'])).toBeNull();
  });

  it('skips a candidate it has no calling code for', () => {
    expect(detectPhoneCountry(['01012345678'], ['ZZ', 'EG'], deps)).toBe('EG');
  });

  it('reads Eastern digits', () => {
    const zero = 0x0660;
    const eastern = [...'01012345678']
      .map((digit) => String.fromCharCode(zero + Number(digit)))
      .join('');
    expect(detect([eastern], 'SA')).toBe('EG');
  });

  it('looks at the first 200 phones only', () => {
    const cells = [
      '',
      ...Array.from({ length: 200 }, () => '01012345678'),
      ...Array.from({ length: 500 }, () => '+966501234567'),
    ];
    expect(detect(cells, 'SA')).toBe('EG');
  });
});
