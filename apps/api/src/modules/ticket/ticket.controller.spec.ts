import { TicketController } from './ticket.controller';

describe('TicketController.children', () => {
  it('delegates to TicketService.getChildTasks with the given id', async () => {
    const ticketService = {
      getChildTasks: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
      ]),
    } as unknown as import('./ticket.service').TicketService;
    const dispatchService = {} as unknown as import('./dispatch.service').DispatchService;

    const controller = new TicketController(ticketService, dispatchService);
    const result = await controller.children('parent-1');

    expect(ticketService.getChildTasks).toHaveBeenCalledWith('parent-1');
    expect(result).toEqual([
      { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
    ]);
  });
});
