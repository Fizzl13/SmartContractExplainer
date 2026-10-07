// In-process facilitator for x402 payments on the XRP Ledger (xrpl:0, RLUSD), as in ichimoku-signal and
// presign-guard. The payer signs a complete XRPL Payment and pays the XRPL fee itself; the facilitator verifies
// it (signature, destination, amount, sequence, InvoiceID, simulation) and submits it, so no key or balance is
// needed here. t54's hosted facilitator rejected a payment that @x402/xrpl accepts (testnet, Oct 2026), so it is
// not used. getSupported() needs no network: the service starts even when the XRPL node is down, and only XRPL
// payments fail then (nothing is charged).
'use strict';

const { x402Facilitator } = require('@x402/core/facilitator');
const { ExactXrplScheme } = require('@x402/xrpl/exact/facilitator');

const XRPL = 'xrpl:0';

function createXrplFacilitator({ network = XRPL, wsUrl = 'wss://xrplcluster.com', scheme } = {}) {
  const facilitator = new x402Facilitator().register(network, scheme || new ExactXrplScheme({ wsUrlByNetwork: { [network]: wsUrl } }));
  return {
    getSupported: async () => facilitator.getSupported(),
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };
}

module.exports = { createXrplFacilitator, XRPL };
