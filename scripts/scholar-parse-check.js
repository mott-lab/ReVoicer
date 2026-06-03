// Offline check for the reference-parse heuristics. Run:  node scripts/scholar-parse-check.js
// Prints the DOI/arXiv, extracted title, and cleaned query for a spread of
// real-world citation styles. No network. Add the references you see fail in
// the app to SAMPLES to tune the heuristics.

const { extractIdentifiers, extractTitle, cleanQuery } = require('../services/reference-parse');

const SAMPLES = [
  // IEEE — quoted title
  '[1] A. Krizhevsky, I. Sutskever, and G. E. Hinton, "ImageNet classification with deep convolutional neural networks," in Advances in Neural Information Processing Systems, vol. 25, pp. 1097-1105, 2012.',
  // APA — (year). Title.
  'Vaswani, A., Shazeer, N., Parmar, N., et al. (2017). Attention is all you need. Advances in Neural Information Processing Systems, 30, 5998-6008.',
  // ACM — Authors. Year. Title. In Venue.
  '12. Jane Doe and Richard Roe. 2021. A study of mixed-initiative interaction in creative tools. In Proceedings of the 2021 CHI Conference on Human Factors in Computing Systems. ACM, 1-13.',
  // Springer — Authors (Year) Title. Venue Vol:pages
  'Smith J, Brown K (2019) Reinforcement learning for robotic grasping. Auton Robots 43:1289-1305. https://doi.org/10.1007/s10514-018-9803-9',
  // arXiv preprint
  '[4] T. Brown et al., "Language models are few-shot learners," arXiv:2005.14165, 2020.',
  // DOI-bearing, no quotes
  'Devlin, J., Chang, M.-W., Lee, K., & Toutanova, K. (2019). BERT: Pre-training of deep bidirectional transformers for language understanding. In NAACL-HLT. doi:10.18653/v1/N19-1423',
  // Authors. Title. Venue (no year early, no quotes) — the hard (c) case
  '7. Yann LeCun, Yoshua Bengio, Geoffrey Hinton. Deep learning. Nature, 521(7553):436-444, 2015.',
];

for (const raw of SAMPLES) {
  const ids = extractIdentifiers(raw);
  console.log('\nraw   :', raw.slice(0, 90) + (raw.length > 90 ? '…' : ''));
  console.log('doi   :', ids.doi);
  console.log('arxiv :', ids.arxiv);
  console.log('title :', extractTitle(raw));
  console.log('query :', cleanQuery(raw));
}
