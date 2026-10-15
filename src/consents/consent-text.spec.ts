import { createHash } from 'crypto';
import { ConsentValues, consentChecksum, renderConsentText } from './consent-text';

const values: ConsentValues = {
  paciente: 'Ana Pérez',
  identificacion: '0102030405',
  tratamiento: 'Toxina botulínica',
  profesional: 'Dr. Luis Mora',
  fecha: '15 de octubre de 2026',
};

describe('renderConsentText', () => {
  it('renders all five variables', () => {
    const text = '{{paciente}}|{{identificacion}}|{{tratamiento}}|{{profesional}}|{{fecha}}';
    expect(renderConsentText(text, values)).toBe(
      'Ana Pérez|0102030405|Toxina botulínica|Dr. Luis Mora|15 de octubre de 2026',
    );
  });

  it('tolerates spaces inside the braces', () => {
    expect(renderConsentText('Yo, {{ paciente }}, y {{  fecha  }}', values)).toBe(
      'Yo, Ana Pérez, y 15 de octubre de 2026',
    );
  });

  it('leaves unknown names verbatim', () => {
    expect(renderConsentText('{{otro}} y {{ paciente }}', values)).toBe('{{otro}} y Ana Pérez');
  });

  it('replaces repeated occurrences', () => {
    expect(renderConsentText('{{paciente}} / {{paciente}}', values)).toBe('Ana Pérez / Ana Pérez');
  });

  it('does not reinterpret replacement text such as $&', () => {
    expect(renderConsentText('{{paciente}}', { ...values, paciente: '$& $1' })).toBe('$& $1');
  });
});

describe('consentChecksum', () => {
  it('is the sha256 hex of title, newline and body', () => {
    expect(consentChecksum('T', 'B')).toBe(createHash('sha256').update('T\nB').digest('hex'));
  });

  it('changes when one character changes', () => {
    expect(consentChecksum('T', 'B')).not.toBe(consentChecksum('T', 'C'));
    expect(consentChecksum('T', 'B')).not.toBe(consentChecksum('U', 'B'));
  });
});
