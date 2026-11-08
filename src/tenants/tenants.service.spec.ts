import { TenantsService } from './tenants.service';

describe('TenantsService.update', () => {
  const update = jest.fn();
  const service = new TenantsService({ tenant: { update } } as never);

  beforeEach(() => update.mockReset().mockResolvedValue({ id: 'tenant-1' }));

  it('stores a cleared phone or address as missing', async () => {
    await service.update('tenant-1', { name: 'Consultorio', phone: '', address: '' });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tenant-1' },
        data: { name: 'Consultorio', phone: null, address: null },
      }),
    );
  });

  it('leaves out the fields that were not sent', async () => {
    await service.update('tenant-1', { email: 'contacto@bienestar.ec' });

    expect(update.mock.calls[0][0].data).toEqual({ email: 'contacto@bienestar.ec' });
  });
});
