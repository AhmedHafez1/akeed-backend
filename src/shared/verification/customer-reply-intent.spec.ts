import { resolveReplyText } from './customer-reply-intent';

describe('resolveReplyText', () => {
  it.each([
    ['نعم', 'confirmed'],
    ['Yes!', 'confirmed'],
    ['1', 'confirmed'],
    ['لا', 'canceled'],
    ['cancel', 'canceled'],
  ] as const)(
    'still reads the Arabic and English answer %s',
    (text, intent) => {
      expect(resolveReplyText(text)).toBe(intent);
    },
  );

  it.each([
    ['جی ہاں', 'confirmed'],
    ['ہاں۔', 'confirmed'],
    ['کنفرم', 'confirmed'],
    ['نہیں', 'canceled'],
    ['کینسل', 'canceled'],
  ] as const)('reads the Urdu answer %s', (text, intent) => {
    expect(resolveReplyText(text)).toBe(intent);
  });

  it.each([
    ['Sí', 'confirmed'],
    ['¡Sí!', 'confirmed'],
    ['si', 'confirmed'],
    ['Confirmo', 'confirmed'],
    ['No', 'canceled'],
    ['Cancelar', 'canceled'],
  ] as const)('reads the Spanish answer %s', (text, intent) => {
    expect(resolveReplyText(text)).toBe(intent);
  });

  it.each([
    ['Oui', 'confirmed'],
    ['Je confirme.', 'confirmed'],
    ["D'accord", 'confirmed'],
    ['D\u2019accord', 'confirmed'],
    ['Non', 'canceled'],
    ['Annuler', 'canceled'],
  ] as const)('reads the French answer %s', (text, intent) => {
    expect(resolveReplyText(text)).toBe(intent);
  });

  it.each(['', 'quizás', 'peut-être', 'کل بتاؤں گا', 'sí pero mañana'])(
    'leaves the unclear answer "%s" unresolved',
    (text) => {
      expect(resolveReplyText(text)).toBeNull();
    },
  );
});
