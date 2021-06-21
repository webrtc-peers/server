
require('babel-core/register')({
  presets: [
    [
      'env',
      {
        targets: {
          node: 'current'
        }
      }
    ],
    'stage-2'
  ]
})
require('./app')