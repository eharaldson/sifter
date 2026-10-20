import { FindAPIClient } from '@find/sdk';

// Initialize the API client with your backend URL
const apiClient = new FindAPIClient(
  import.meta.env.VITE_API_URL
);

export { apiClient };
export * from '@find/sdk';
