module.exports = {
  name: 'hsr',
  preset: '../../jest.config.js',
  coverageDirectory: '../../coverage/apps/hsr',
  snapshotSerializers: [
    'jest-preset-angular/build/AngularNoNgAttributesSnapshotSerializer.js',
    'jest-preset-angular/build/AngularSnapshotSerializer.js',
    'jest-preset-angular/build/HTMLCommentSerializer.js'
  ]
};
