var db = require("../config/connection");
var bcrypt = require("bcrypt");
var promise = require("promise");

module.exports = {
  adminLogin: (Admindata) => {
    const response = {};
    return new promise(async (resolve, reject) => {
      try {
        let Admin = await db
          .get()
          .collection("admin")
          .findOne({Username: Admindata.Username });
         
          

        if (Admin) {
          await bcrypt
            .compare(Admindata.Password, Admin.Password)
            .then((status) => {
              if (status) {
                response.admin = Admin;
                response.status = true;
                resolve(response);
              } else {
                resolve(false);
              }
            });
        } else {
          resolve(false);
        }
      } catch (err) {
        res.status(400).json("Error ocuured ", err);
      }
    });
  },
  countUsers: async () => {
    const count = await db.get().collection("user").countDocuments();
    return count;
  },

  countStaff: async () => {
    const count = await db.get().collection("staff").countDocuments();
    return count;
  },

  countBooks: async () => {
    const count = await db.get().collection("novels").countDocuments();
    return count;
  }
  
};
