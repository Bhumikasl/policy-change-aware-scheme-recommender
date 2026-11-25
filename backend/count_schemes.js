require("dotenv").config();
const mongoose = require("mongoose");
const Scheme = require("./src/models/Scheme");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const total = await Scheme.countDocuments({});
  const byStatus = await Scheme.aggregate([
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  console.log("Total schemes:", total);
  console.log("By status:", byStatus);
  await mongoose.disconnect();
})();