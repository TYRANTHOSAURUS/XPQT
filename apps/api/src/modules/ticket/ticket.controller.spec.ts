import { TicketController } from './ticket.controller';

describe('TicketController.children', () => {
  it('delegates to TicketService.getChildTasks with the given id and actor', async () => {
    const ticketService = {
      getChildTasks: jest.fn().mockResolvedValue([
        { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
      ]),
    } as unknown as import('./ticket.service').TicketService;
    const dispatchService = {} as unknown as import('./dispatch.service').DispatchService;
    const visibilityService = {} as unknown as import('./ticket-visibility.service').TicketVisibilityService;

    const controller = new TicketController(ticketService, dispatchService, visibilityService);
    const request = { user: { id: 'auth-123' } } as unknown as import('express').Request;
    const result = await controller.children(request, 'parent-1');

    expect(ticketService.getChildTasks).toHaveBeenCalledWith('parent-1', 'auth-123');
    expect(result).toEqual([
      { id: 'c1', title: 'Replace pane', ticket_kind: 'work_order' },
    ]);
  });
});
