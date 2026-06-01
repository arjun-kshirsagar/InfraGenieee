/**
 * InfraGenie — barrel for the structured price-feed adapters (task B4).
 *
 * These adapters exist because Tavily physically cannot price AWS EC2/SQS or
 * Azure (their pages render numbers client-side). Each is a plain public HTTPS
 * GET against the provider's own free, unauthenticated price feed, held to the
 * SAME evidence gate as the Tavily path (see `./types.ts`). SERVER-ONLY.
 */

export {
  fetchAwsPriceList,
  type AwsPriceListQuery,
} from './aws-price-list';
export {
  fetchEc2Metered,
  ec2MeteredUrl,
  decodeMeteredBody,
  type Ec2MeteredQuery,
} from './aws-ec2-metered';
export {
  fetchAzureRetail,
  azureRetailUrl,
  buildAzureFilter,
  type AzureRetailQuery,
  type AzureRetailItem,
} from './azure-retail';
export {
  type FeedPriceCandidate,
  type FeedResult,
} from './types';
