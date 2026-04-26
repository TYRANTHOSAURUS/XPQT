export interface CostCenter {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  default_approver_person_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}
