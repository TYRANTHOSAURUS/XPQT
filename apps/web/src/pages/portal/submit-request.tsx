import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle, MapPin } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { usePortal } from '@/providers/portal-provider';
import { DynamicFormFields } from '@/components/form-renderer/dynamic-form-fields';
import { splitFormData, validateRequired } from '@/lib/form-submission';
import type { FormField } from '@/components/admin/form-builder/premade-fields';
import { AssetCombobox } from '@/components/asset-combobox';
import { PersonPicker } from '@/components/person-picker';
import {
  PortalLocationDrilldown,
  satisfiesGranularity,
} from '@/components/portal/portal-location-drilldown';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalFormHeader } from '@/components/portal/portal-form-header';
import { PortalFormFooter } from '@/components/portal/portal-form-footer';

interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  kb_link: string | null;
  disruption_banner: string | null;
  keywords: string[];
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  form_schema_id: string | null;
  intake: {
    requires_location: boolean;
    location_required: boolean;
    location_granularity: string | null;
    requires_asset: boolean;
    asset_required: boolean;
    asset_type_filter: string[];
  };
}

interface CatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  request_types: CatalogRequestType[];
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: CatalogCategory[];
}

interface FormSchemaEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

const submitSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title is too long'),
  description: z.string().max(5000, 'Description is too long').optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']),
  requestTypeId: z.string().min(1, 'Pick a request type'),
});

type SubmitFormValues = z.infer<typeof submitSchema>;

export function SubmitRequestPage() {
  const navigate = useNavigate();
  const { categoryId } = useParams();
  const { data: portal } = usePortal();
  const [searchParams] = useSearchParams();
  const preselectedType = searchParams.get('type') ?? '';

  const currentLocation = portal?.current_location ?? null;

  const [catalog, setCatalog] = useState<PortalCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [assetId, setAssetId] = useState<string | null>(null);
  const [requestedForPersonId, setRequestedForPersonId] = useState<string | null>(null);
  const [assetLocationSummary, setAssetLocationSummary] = useState<{ id: string; name: string } | null>(null);
  const [drilledLocation, setDrilledLocation] = useState<{ id: string; name: string; type: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const {
    control,
    handleSubmit,
    watch,
    register,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<SubmitFormValues>({
    resolver: zodResolver(submitSchema),
    defaultValues: { title: '', description: '', priority: 'normal', requestTypeId: preselectedType },
  });

  const requestTypeId = watch('requestTypeId');

  // Load catalog scoped to the portal's currently-selected location.
  useEffect(() => {
    if (!currentLocation) {
      setCatalog(null);
      return;
    }
    setCatalogLoading(true);
    setCatalogError(null);
    apiFetch<PortalCatalogResponse>(`/portal/catalog?location_id=${encodeURIComponent(currentLocation.id)}`)
      .then(setCatalog)
      .catch((e) => setCatalogError(e instanceof Error ? e.message : 'Failed to load catalog'))
      .finally(() => setCatalogLoading(false));
  }, [currentLocation?.id, currentLocation]);

  // Flatten visible request types; optionally filter by categoryId from URL.
  const requestTypes = useMemo<CatalogRequestType[]>(() => {
    if (!catalog) return [];
    if (categoryId) {
      const cat = catalog.categories.find((c) => c.id === categoryId);
      return cat?.request_types ?? [];
    }
    return catalog.categories.flatMap((c) => c.request_types);
  }, [catalog, categoryId]);

  const selectedRT = requestTypes.find((r) => r.id === requestTypeId);

  // The parent category metadata for the back-link label.
  const parentCategory = categoryId
    ? catalog?.categories.find((c) => c.id === categoryId) ?? null
    : null;

  // Reflect ?type=<id> into the form state.
  useEffect(() => {
    if (preselectedType && preselectedType !== requestTypeId) {
      setValue('requestTypeId', preselectedType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preselectedType]);

  // When the RT changes, load its form schema and reset asset/location state
  // that may no longer apply to the new RT (codex v4 review: hidden asset state).
  useEffect(() => {
    setDrilledLocation(null);
    if (!selectedRT?.intake.requires_asset) {
      setAssetId(null);
      setAssetLocationSummary(null);
    }
    // Clear requestedForPersonId when the new item is self_only OR when no
    // item is selected. Prevents a stale target from being submitted after
    // switching away from an on-behalf-capable item.
    if (!selectedRT || selectedRT.on_behalf_policy === 'self_only') {
      setRequestedForPersonId(null);
    }
    if (!selectedRT?.form_schema_id) {
      setFormFields([]);
      setValues({});
      return;
    }
    apiFetch<FormSchemaEntity>(`/config-entities/${selectedRT.form_schema_id}`)
      .then((entity) => {
        setFormFields(entity.current_version?.definition?.fields ?? []);
        setValues({});
      })
      .catch(() => setFormFields([]));
  }, [selectedRT?.id, selectedRT?.form_schema_id, selectedRT?.intake.requires_asset, selectedRT?.on_behalf_policy]);

  const needsDrilldown = useMemo(() => {
    if (!selectedRT?.intake.location_granularity || !currentLocation) return false;
    return !satisfiesGranularity(currentLocation.type, selectedRT.intake.location_granularity);
  }, [selectedRT?.intake.location_granularity, currentLocation]);

  // The location we'll submit to the backend. Only user-picked / drilled values —
  // never asset-resolved (that runs server-side to preserve scope_source provenance).
  const submitLocationId: string | null = useMemo(() => {
    if (drilledLocation) return drilledLocation.id;
    if (needsDrilldown) return null;
    return currentLocation?.id ?? null;
  }, [drilledLocation, needsDrilldown, currentLocation]);

  const onSubmit = async (formValues: SubmitFormValues) => {
    setSubmitError(null);

    const missing = validateRequired(formFields, values);
    if (missing) {
      toast.error(`"${missing.label}" is required`);
      return;
    }

    if (selectedRT?.intake.location_required && !submitLocationId && !assetId) {
      toast.error('Please pick a location or asset');
      return;
    }

    if (selectedRT?.intake.location_granularity && !submitLocationId && !assetId) {
      toast.error('Please drill down to the required location');
      return;
    }

    const { bound, form_data } = splitFormData(formFields, values);

    try {
      await apiFetch('/portal/tickets', {
        method: 'POST',
        body: JSON.stringify({
          request_type_id: formValues.requestTypeId,
          title: formValues.title,
          description: formValues.description,
          priority: formValues.priority,
          asset_id: assetId ?? undefined,
          location_id: submitLocationId ?? undefined,
          requested_for_person_id: requestedForPersonId ?? undefined,
          ...bound,
          form_data: Object.keys(form_data).length > 0 ? form_data : undefined,
        }),
      });
      toast.success('Request submitted');
      navigate('/portal/requests');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit request';
      setSubmitError(msg);
      toast.error(msg);
    }
  };

  const backTo = categoryId ? `/portal/catalog/${categoryId}` : '/portal';
  const backLabel = parentCategory?.name ? `Back to ${parentCategory.name}` : 'Back';

  return (
    <PortalPage>
      <div className="mx-auto max-w-[920px]">
        <PortalFormHeader
          iconName={selectedRT?.icon}
          name={selectedRT?.name ?? 'Submit a Request'}
          whatHappensNext={selectedRT?.description}
          backTo={backTo}
          backLabel={backLabel}
        />

        <form onSubmit={handleSubmit(onSubmit)} className="mt-8">
          {catalogError && (
            <Alert variant="destructive" className="mb-6">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Catalog failed to load</AlertTitle>
              <AlertDescription>{catalogError}</AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            {/* Request type selector — shown when no type is pre-selected or when arriving from a general URL */}
            <Field>
              <FieldLabel htmlFor="request-type">Request Type</FieldLabel>
              <Controller
                control={control}
                name="requestTypeId"
                render={({ field }) => (
                  <Select
                    value={field.value ?? ''}
                    onValueChange={(v) => field.onChange(v ?? '')}
                    disabled={catalogLoading}
                  >
                    <SelectTrigger id="request-type">
                      <SelectValue
                        placeholder={
                          catalogLoading
                            ? 'Loading…'
                            : requestTypes.length === 0
                              ? 'No services available here'
                              : 'Select a service'
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {requestTypes.map((rt) => (
                        <SelectItem key={rt.id} value={rt.id}>
                          {rt.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {currentLocation && (
                <FieldDescription>
                  Showing services for <span className="font-medium">{currentLocation.name}</span>.
                </FieldDescription>
              )}
              {errors.requestTypeId && <FieldError>{errors.requestTypeId.message}</FieldError>}
            </Field>

            {selectedRT?.intake.requires_asset && (
              <Field>
                <FieldLabel htmlFor="portal-asset">
                  Asset
                  {selectedRT.intake.asset_required && <span className="text-destructive ml-1">*</span>}
                </FieldLabel>
                <AssetCombobox
                  value={assetId}
                  onChange={(id, asset) => {
                    setAssetId(id);
                    if (asset?.assigned_space_id) {
                      setAssetLocationSummary({
                        id: asset.assigned_space_id,
                        name: (asset as { assigned_space?: { name?: string } }).assigned_space?.name ?? 'asset location',
                      });
                    } else {
                      setAssetLocationSummary(null);
                    }
                  }}
                  assetTypeFilter={selectedRT.intake.asset_type_filter ?? []}
                />
                {assetLocationSummary && (
                  <FieldDescription className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> From asset: {assetLocationSummary.name}
                  </FieldDescription>
                )}
              </Field>
            )}

            {selectedRT && selectedRT.on_behalf_policy !== 'self_only' && (
              <Field>
                <FieldLabel htmlFor="portal-requested-for">Requesting for</FieldLabel>
                <PersonPicker
                  value={requestedForPersonId ?? ''}
                  onChange={(v) => setRequestedForPersonId(v || null)}
                  placeholder="Leave blank to request for yourself"
                />
                <FieldDescription>
                  This service allows submitting on behalf of another person.
                  {selectedRT.on_behalf_policy === 'direct_reports' && ' Limited to your direct reports.'}
                  {selectedRT.on_behalf_policy === 'configured_list' && ' Target is validated server-side.'}
                </FieldDescription>
              </Field>
            )}

            {selectedRT?.intake.location_granularity && needsDrilldown && currentLocation && (
              <Field>
                <FieldLabel htmlFor="portal-drilldown">
                  Location
                  {selectedRT.intake.location_required && <span className="text-destructive ml-1">*</span>}
                </FieldLabel>
                <PortalLocationDrilldown
                  rootSpace={currentLocation}
                  granularity={selectedRT.intake.location_granularity}
                  onPick={(s) => setDrilledLocation(s)}
                  selected={drilledLocation}
                />
                {drilledLocation && (
                  <FieldDescription className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Selected: {drilledLocation.name}
                    <Badge variant="outline" className="ml-1 text-xs capitalize">
                      {drilledLocation.type.replace('_', ' ')}
                    </Badge>
                  </FieldDescription>
                )}
              </Field>
            )}

            <Field>
              <FieldLabel htmlFor="title">Title</FieldLabel>
              <Input
                id="title"
                placeholder="Brief summary of your request..."
                aria-invalid={!!errors.title}
                {...register('title')}
              />
              {errors.title && <FieldError>{errors.title.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Textarea
                id="description"
                placeholder="Provide details about your request..."
                className="min-h-[120px]"
                aria-invalid={!!errors.description}
                {...register('description')}
              />
              {errors.description && <FieldError>{errors.description.message}</FieldError>}
            </Field>

            <Field>
              <FieldLabel htmlFor="priority">Priority</FieldLabel>
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={(v) => field.onChange((v ?? 'normal') as SubmitFormValues['priority'])}>
                    <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="low">Low — not urgent</SelectItem>
                      <SelectItem value="normal">Normal — usual priority</SelectItem>
                      <SelectItem value="high">High — needs attention soon</SelectItem>
                      <SelectItem value="urgent">Urgent — blocking my work</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>

            <DynamicFormFields
              fields={formFields}
              values={values}
              onChange={(id, v) => setValues((prev) => ({ ...prev, [id]: v }))}
              useChips
            />

            {submitError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Submission failed</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
          </FieldGroup>

          <PortalFormFooter
            onCancel={() => navigate(backTo)}
            onSubmit={handleSubmit(onSubmit)}
            submitting={isSubmitting}
          />
        </form>
      </div>
    </PortalPage>
  );
}
