const truthy = (v: string | undefined) => v === 'true' || v === '1';

export const features = {
  routingStudio: truthy(import.meta.env.VITE_FEATURE_ROUTING_STUDIO),
};
