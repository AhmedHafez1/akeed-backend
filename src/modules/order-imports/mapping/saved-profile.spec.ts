import type { ImportField } from './alias-dictionary';
import { matchColumns, type FieldSuggestion } from './column-matcher';
import { applySavedProfile } from './saved-profile';

function byField(fields: FieldSuggestion[]) {
  return Object.fromEntries(
    fields.map((suggestion) => [suggestion.field, suggestion]),
  ) as Record<ImportField, FieldSuggestion>;
}

function apply(headers: string[], saved: Record<string, unknown>) {
  const result = applySavedProfile(matchColumns(headers, []), headers, saved);
  return { ...result, fields: byField(result.fields) };
}

describe('applySavedProfile (US-04.6-03 AC8)', () => {
  const headers = ['Tel', 'Client', 'Sum', 'Ref', 'Remarks'];

  it('applies every saved field with source "saved"', () => {
    const { fields, unmappedColumns } = apply(headers, {
      phone: 'Tel',
      customerName: ['Client'],
      amount: 'Sum',
      orderReference: 'Ref',
      notes: null,
    });
    expect(fields.phone).toMatchObject({
      columns: ['Tel'],
      source: 'saved',
      confidence: 'exact',
    });
    expect(fields.customerName).toMatchObject({
      columns: ['Client'],
      source: 'saved',
    });
    expect(fields.amount).toMatchObject({ columns: ['Sum'], source: 'saved' });
    expect(fields.orderReference).toMatchObject({
      columns: ['Ref'],
      source: 'saved',
    });
    // A deliberate "not imported" is remembered too.
    expect(fields.notes).toMatchObject({ columns: [], source: 'saved' });
    expect(unmappedColumns).toEqual(['Remarks']);
  });

  it('falls back to detection field by field when a saved header is gone', () => {
    const { fields } = apply(['Mobile', 'Customer Name', 'Total'], {
      phone: 'Old Phone Column',
      customerName: ['Customer Name'],
      amount: 'Old Amount',
    });
    expect(fields.phone).toMatchObject({
      columns: ['Mobile'],
      source: 'auto',
    });
    expect(fields.customerName).toMatchObject({
      columns: ['Customer Name'],
      source: 'saved',
    });
    expect(fields.amount).toMatchObject({ columns: ['Total'], source: 'auto' });
  });

  it('falls back for a name pair when one of its columns is gone', () => {
    const { fields } = apply(['First Name', 'Customer', 'Phone'], {
      customerName: ['First Name', 'Last Name'],
    });
    expect(fields.customerName).toMatchObject({
      columns: ['Customer'],
      source: 'auto',
    });
  });

  it('finds a saved header spelled differently in the new file', () => {
    const { fields } = apply(['TEL', 'Client'], { phone: 'Tel' });
    expect(fields.phone).toMatchObject({ columns: ['TEL'], source: 'saved' });
  });

  it('clears a detected field whose column a saved field now uses', () => {
    const { fields } = apply(['Phone', 'Mobile'], {
      phone: 'Mobile',
      notes: 'Phone',
    });
    expect(fields.phone).toMatchObject({
      columns: ['Mobile'],
      source: 'saved',
    });
    expect(fields.notes).toMatchObject({ columns: ['Phone'], source: 'saved' });
    expect(fields.phone.alternatives).not.toContain('Phone');
  });

  it('ignores malformed saved values', () => {
    const { fields } = apply(['Phone'], { phone: 42, amount: [1, 2] });
    expect(fields.phone).toMatchObject({ columns: ['Phone'], source: 'auto' });
    expect(fields.amount).toMatchObject({ columns: [], source: 'none' });
  });
});
