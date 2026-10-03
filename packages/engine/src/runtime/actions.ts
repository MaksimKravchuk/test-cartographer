import type { Page } from '@playwright/test';
import type { DataValues, Interface, Role } from '@tc/model';

export type ActionContext = {
  page: Page;
  role: Role;
  iface: Interface;
  variant: string;
  // Value of the entity's correlation key (for example, the order id).
  // Empty while the instance doesn't exist yet (a creating transition).
  key: string;
  // Keys of related instances by relation id (for example, the listing an order is placed for).
  related: Record<string, string>;
  // Arguments for the action: login credentials for a login action.
  args: Record<string, string>;
  // Fields people attached to roles and entities, real values ({{env.NAME}}
  // resolved): data.roles.seller.password, data.entities.order.promo.
  data: DataValues;
  // The last actual entity state that was read.
  entity: Record<string, unknown>;
  // Open a path relative to the baseUrl of the role's interface.
  open(path?: string): Promise<void>;
};

export type ActionDef = {
  description?: string;
  // A creating action (a transition from @new) must return the new instance's key.
  run(ctx: ActionContext): Promise<void | string>;
  // Whether the interface offers this action right now. Needed to check forbidden actions.
  available?(ctx: ActionContext): Promise<boolean>;
};

export type Actions = Record<string, ActionDef>;

export function defineActions<T extends Actions>(actions: T): T {
  return actions;
}
