/**
 * pdfkit loads its built-in fonts on first use through its private `#standard-fonts/*`
 * imports, which the file tracing of the Vercel deployment does not follow: the function is
 * shipped without them and every PDF fails with MODULE_NOT_FOUND. Requiring them here, where a
 * tracer sees them, ships the fonts the PDFs use. A font added to a PDF is added here too.
 */
import 'pdfkit/standard-fonts/Helvetica';
import 'pdfkit/standard-fonts/HelveticaBold';

export const STANDARD_FONTS = ['Helvetica', 'Helvetica-Bold'] as const;
