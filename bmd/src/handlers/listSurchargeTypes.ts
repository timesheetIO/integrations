import { defineHandler } from '@timesheet/integration-sdk';
import type { BmdConfig, EntityListResult } from '../lib/types';
import { SURCHARGE_TYPES } from '../lib/common';

/** Left side of the Zuschlagsarten mapping: a fixed list the export knows how to fill. */
export const listSurchargeTypes = defineHandler<void, EntityListResult, BmdConfig>(async () => ({
  items: SURCHARGE_TYPES.map(type => ({ ...type }))
}));
