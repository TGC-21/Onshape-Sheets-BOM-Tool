import { findListing } from './catalog.js'
export async function attachVendorSnapshots(rows) {
  return Promise.all(rows.map(async (row) => {
    const listing = await findListing(row.partNumber)
    if (!listing) return row
    return { ...row, vendorListing: listing, vendorSnapshot: JSON.stringify(listing), vendorListings: [listing] }
  }))
}
