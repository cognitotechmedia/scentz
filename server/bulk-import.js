'use strict';
// Reuse individual record validation inside savepoints; previews leave no writes.
module.exports = ({ db, saveProduct, createCustomer, HttpError }) => kind => context => {
  const { rows, preview } = context.body;
  if (!Array.isArray(rows) || !rows.length || rows.length > 500) throw new HttpError(400, 'Upload between 1 and 500 rows');
  if (typeof preview !== 'boolean') throw new HttpError(400, 'Choose preview or import');
  const errors = [];
  db.exec('SAVEPOINT bulk_upload');
  try {
    rows.forEach((row, index) => {
      db.exec('SAVEPOINT bulk_row');
      try {
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid row');
        const body = { ...row };
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100) throw new Error('Name is required (maximum 100 characters)');
        if (kind === 'products') {
          if (body.price === undefined || String(body.price).trim() === '' || body.gstRate === undefined || String(body.gstRate).trim() === '') throw new Error('Price and gstRate are required');
          for (const key of ['price', 'gstRate', 'cost', 'wholesalePrice', 'franchisePrice', 'sizeMl', 'recipeMl', 'packQty']) {
            if (body[key] !== undefined && body[key] !== '') {
              if (typeof body[key] === 'boolean' || !Number.isFinite(Number(body[key]))) throw new Error(key + ' must be a number');
              body[key] = Number(body[key]);
            }
          }
          for (const key of ['needsRecipe', 'trackStock']) {
            const value = String(body[key] ?? '').trim().toLowerCase();
            if (!['', 'true', 'false', 'yes', 'no', '1', '0'].includes(value)) throw new Error(key + ' must be yes or no');
            body[key] = ['true', 'yes', '1'].includes(value);
          }
          saveProduct({ ...context, body, params: {} });
        } else {
          body.type = String(body.type || 'retail').toLowerCase();
          body.phone = String(body.phone || '').trim();
          createCustomer({ ...context, body, params: {} });
        }
        db.exec('RELEASE bulk_row');
      } catch (error) {
        db.exec('ROLLBACK TO bulk_row; RELEASE bulk_row');
        errors.push({ row: index + 2, message: error.status || !error.code ? error.message : 'Could not save this row; check its values' });
      }
    });
    if (preview || errors.length) db.exec('ROLLBACK TO bulk_upload');
    db.exec('RELEASE bulk_upload');
    return { errors, count: rows.length, imported: !preview && !errors.length ? rows.length : 0 };
  } catch (error) {
    db.exec('ROLLBACK TO bulk_upload; RELEASE bulk_upload');
    throw error;
  }
};
