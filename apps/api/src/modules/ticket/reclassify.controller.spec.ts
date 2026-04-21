import { ReclassifyController } from './reclassify.controller';

describe('ReclassifyController', () => {
  function setup() {
    const service = {
      computeImpact: jest.fn(async () => ({ ticket: { id: 'tk1' } })),
      execute: jest.fn(async () => ({ id: 'tk1', ticket_type_id: 'rt-new' })),
    };
    const controller = new ReclassifyController(service as never);
    return { controller, service };
  }

  it('preview() delegates to computeImpact with auth uid', async () => {
    const { controller, service } = setup();
    const req = { user: { id: 'auth-1' } } as never;
    const result = await controller.preview(req, 'tk1', { newRequestTypeId: 'rt-new' });
    expect(service.computeImpact).toHaveBeenCalledWith('tk1', 'rt-new', 'auth-1');
    expect(result).toEqual({ ticket: { id: 'tk1' } });
  });

  it('preview() throws 401 when no auth user', async () => {
    const { controller } = setup();
    const req = {} as never;
    await expect(controller.preview(req, 'tk1', { newRequestTypeId: 'rt-new' }))
      .rejects.toThrow(/no auth user/i);
  });

  it('execute() extracts auth uid from request and delegates to execute', async () => {
    const { controller, service } = setup();
    const req = { user: { id: 'auth-1' } } as never;
    const result = await controller.execute(req, 'tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate' });
    expect(service.execute).toHaveBeenCalledWith('tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate' }, 'auth-1');
    expect(result).toEqual({ id: 'tk1', ticket_type_id: 'rt-new' });
  });

  it('execute() throws 401 when request has no auth user', async () => {
    const { controller } = setup();
    const req = {} as never;
    await expect(controller.execute(req, 'tk1', { newRequestTypeId: 'rt-new', reason: 'legitimate' }))
      .rejects.toThrow(/no auth user/i);
  });
});
