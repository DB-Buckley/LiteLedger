// ===========================================================================
// Integrity guards
async function hasCustomerActivity(customerId) {
    const docs = await whereIndex("docs", "by_customer", customerId);
    const pays = await whereIndex("payments", "by_customer", customerId);
    return docs.length > 0 || pays.length > 0;
}
async function hasSupplierActivity(supplierId) {
    const docs = await whereIndex("docs", "by_supplier", supplierId);
    return docs.length > 0;
}
