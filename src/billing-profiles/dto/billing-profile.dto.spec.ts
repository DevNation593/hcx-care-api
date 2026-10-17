import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateBillingProfileDto } from './billing-profile.dto';

describe('UpdateBillingProfileDto', () => {
  const errorsFor = (body: Record<string, unknown>) =>
    validate(plainToInstance(UpdateBillingProfileDto, body));

  it('rejects a null isActive instead of letting it reach the database', async () => {
    const errors = await errorsFor({ isActive: null });
    expect(errors.map((error) => error.property)).toEqual(['isActive']);
  });

  it('accepts a boolean isActive and an omitted one', async () => {
    expect(await errorsFor({ isActive: false })).toHaveLength(0);
    expect(await errorsFor({})).toHaveLength(0);
  });
});
