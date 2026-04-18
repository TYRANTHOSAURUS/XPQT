import type { BoundField } from '@prequest/shared';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'dropdown'
  | 'multi_select'
  | 'checkbox'
  | 'radio'
  | 'file_upload'
  | 'person_picker'
  | 'location_picker'
  | 'asset_picker';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
  bound_to?: BoundField;
}

export interface PremadeFieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  bound_to?: BoundField;
  description: string;
}

export const PREMADE_FIELDS: PremadeFieldDef[] = [
  { key: 'affected_person',   label: 'Affected Person',       type: 'person_picker',   required: false,                          description: 'A person other than the requester' },
  { key: 'preferred_date',    label: 'Preferred Date / Time', type: 'datetime',        required: true,                           description: 'When the requester wants this done' },
  { key: 'impact',            label: 'Impact',                type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'impact',  description: 'Business impact — populates the ticket column' },
  { key: 'urgency',           label: 'Urgency',               type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'urgency', description: 'How urgent — populates the ticket column' },
  { key: 'attachments',       label: 'Attachments',           type: 'file_upload',     required: false,                          description: 'File attachments (placeholder)' },
  { key: 'justification',     label: 'Justification / Notes', type: 'textarea',        required: true,                           description: 'Free-text reasoning' },
];

export function premadeFieldToForm(def: PremadeFieldDef, id: string): FormField {
  return {
    id,
    label: def.label,
    type: def.type,
    required: def.required,
    options: def.options,
    bound_to: def.bound_to,
  };
}
