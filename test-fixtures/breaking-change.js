'use strict';

// This module previously exported `formatCurrency` and `parseCurrency`.
// `parseCurrency` has been REMOVED without deprecation notice — a breaking change.

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

// parseCurrency was removed — this is intentional for testing breaking-change detection.
// Previously: function parseCurrency(str) { ... }

module.exports = { formatCurrency };
