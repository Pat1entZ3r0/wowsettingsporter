'use strict';
// Sets the app icon and version details on the packed Windows exe. electron-builder does this
// with rcedit, which needs Wine off Windows; resedit does it in plain JS on any OS.

const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const ResEdit = require('resedit');
  const { productFilename, info } = context.packager.appInfo;
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups[0] || { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map((i) => i.data));

  const version = context.packager.appInfo.version;
  const [major, minor, patch] = version.split('.').map((n) => parseInt(n, 10) || 0);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] || ResEdit.Resource.VersionInfo.createEmpty();
  vi.setFileVersion(major, minor, patch, 0, 1033);
  vi.setProductVersion(major, minor, patch, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: context.packager.appInfo.productName,
    FileDescription: context.packager.appInfo.productName,
    CompanyName: 'First to Forever',
    InternalName: productFilename,
    OriginalFilename: `${productFilename}.exe`,
    LegalCopyright: 'MIT License',
    FileVersion: version,
    ProductVersion: version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  if (info && info.log) info.log(`set icon and version info on ${exePath}`);
};
